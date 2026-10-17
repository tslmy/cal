import type { Express } from "express";
import { z } from "zod";
import { activity, DAY_ONE, getUser, log, newId, resetUser, update } from "../store";
import { runLearner } from "../loop";
import { personaById } from "../../src/shared/personas";
import { daysBetween, mondayOf, TODAY, weekday } from "../../src/shared/dates";
import { fmtDate, fmtWhen } from "../../src/shared/when";

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
import type { CalendarSpec } from "../../src/shared/catalog";
import type { CalEvent, Interaction } from "../../src/shared/types";

const Settings = z.object({ proposalsOn: z.boolean().optional(), minGapMinutes: z.number().int().min(0).max(10080).optional() });
const Replay = z.object({
  persona: z.enum(["jordan", "mina", "sam"]),
  weeks: z.number().int().min(1).max(26).default(8),
  delayMs: z.number().int().min(0).max(5000).default(1200),
  wait: z.boolean().default(false),
  week: z.number().int().min(0).max(25).optional(), // apply just this week (the chat-style scrub); week 0 starts from a clean slate
});

const WEEK_MS = 7 * 86400000;
const WEEK_VIEW: CalendarSpec = { root: "view", elements: { view: { type: "WeekGrid", props: { weekOf: mondayOf(TODAY), days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], startHour: 8, endHour: 18 }, children: [] } } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Habit learner, belief deletion, adaptation settings and the demo time-scrub.
export default function register(app: Express) {
  app.post("/api/learning/:user/run", async (req, res) => {
    if (!getUser(req.params.user)) return res.status(404).json({ error: "no such user" });
    await runLearner(req.params.user, "On request");
    res.json(getUser(req.params.user));
  });

  // P11: deleting a belief. The learner only re-learns it from evidence logged after this.
  const remove = async (user: string, key: string) => {
    const b = await update(user, (s) => {
      const b = s.beliefs.find((x) => x.key === key);
      if (!b) return null;
      s.beliefs = s.beliefs.filter((x) => x.key !== key);
      activity(s, b.level === "meta" ? "Meta-learner" : "Habit learner", `You deleted "${b.statement}". I'll only re-learn it from new evidence.`);
      return b;
    });
    if (b) await log(user, "belief_deleted", { key, statement: b.statement, level: b.level, confidence: b.confidence, evidence: b.evidence.length }, "manual");
    return b;
  };
  app.delete("/api/learning/:user/beliefs/:key", async (req, res) => {
    if (!getUser(req.params.user)) return res.status(404).json({ error: "no such user" });
    if (!(await remove(req.params.user, req.params.key))) return res.status(404).json({ error: "no such belief" });
    res.json(getUser(req.params.user));
  });
  app.post("/api/learning/:user/beliefs/:key/delete", async (req, res) => {
    if (!getUser(req.params.user)) return res.status(404).json({ error: "no such user" });
    if (!(await remove(req.params.user, req.params.key))) return res.status(404).json({ error: "no such belief" });
    res.json(getUser(req.params.user));
  });

  // P12: proposals on or off, and how often.
  app.post("/api/learning/:user/settings", async (req, res) => {
    const body = Settings.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: body.error.issues[0].message });
    if (!getUser(req.params.user)) return res.status(404).json({ error: "no such user" });
    const before = await update(req.params.user, (s) => {
      const before = { ...s.settings };
      Object.assign(s.settings, body.data);
      const { proposalsOn, minGapMinutes } = s.settings;
      activity(s, "Proposal gate", proposalsOn ? `Suggestions on, at most one every ${minGapMinutes ? `${minGapMinutes} min` : "time a habit is confident"}.` : "Suggestions off.");
      return before;
    });
    await log(req.params.user, "settings_changed", { before, after: body.data }, "manual");
    res.json(getUser(req.params.user));
  });

  // Demo time-scrub: replays a sample person's events and a plausible history into this person's
  // log as interactions spread over simulated weeks, running the learner after each week.
  // The requests a scrub will "type", one list per simulated week, so the page can show them as
  // chat messages before each week is applied.
  app.get("/api/learning/replay-plan/:persona", (req, res) => {
    const body = Replay.safeParse({ persona: req.params.persona, weeks: Number(req.query.weeks ?? 8) });
    if (!body.success) return res.status(400).json({ error: body.error.issues[0].message });
    res.json({ weeks: batches(body.data.persona, body.data.weeks).map(sentences) });
  });

  app.post("/api/learning/:user/replay", async (req, res) => {
    const body = Replay.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: body.error.issues[0].message });
    if (!getUser(req.params.user)) return res.status(404).json({ error: "no such user" });
    if (body.data.week !== undefined) {
      const { persona, weeks, week } = body.data;
      if (week === 0) await resetUser(req.params.user, true);
      await replayWeek(req.params.user, persona, weeks, week);
      return res.json(getUser(req.params.user));
    }
    const run = replay(req.params.user, body.data);
    if (!body.data.wait) {
      run.catch((err) => console.error("[replay]", err));
      return res.json(getUser(req.params.user));
    }
    try {
      await run;
      res.json(getUser(req.params.user));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}

// The sample person's events split into simulated weeks. Someone with a dense calendar fills in
// the dates nearest today first, so the calendar on screen (which shows today) grows from the first
// week; a long-range planner adds plans in no particular date order, so their weeks get an even mix.
function batches(persona: string, weeks: number): CalEvent[][] {
  const p = personaById(persona)!;
  const near = (e: CalEvent) => Math.abs(daysBetween(TODAY, e.start.slice(0, 10)));
  const sorted = [...p.events].sort((a, b) => near(a) - near(b) || a.start.localeCompare(b.start));
  const dense = sorted.length >= weeks * 5;
  const weekOf = (i: number) => (dense ? Math.floor((i * weeks) / sorted.length) : i % weeks);
  return Array.from({ length: weeks }, (_, k) => sorted.filter((_, i) => weekOf(i) === k));
}

// What the person might have typed to add a week's events: one request per title, so a daily
// standup reads as one sentence rather than five.
function sentences(batch: CalEvent[]): string[] {
  const groups = new Map<string, CalEvent[]>();
  for (const e of batch) groups.set(e.title, [...(groups.get(e.title) ?? []), e]);
  return [...groups.entries()].map(([title, evs]) => {
    const e = evs[0];
    if (evs.length === 1) {
      if (e.start.length > 10) return `${title} on ${fmtWhen(e)}`;
      if (e.start === e.end) return `${title} on ${fmtDate(e.start)}`;
      return e.precision === "week" ? `${title}, ${fmtWhen(e).toLowerCase()}` : `${title} from ${fmtDate(e.start)} to ${fmtDate(e.end)}`;
    }
    const days = [...new Set(evs.map((x) => weekday(x.start.slice(0, 10))))];
    const at = e.start.length > 10 ? ` at ${e.start.slice(11, 16)}` : "";
    const when = days.length === 5 && days.every((d) => d < 5) ? "every weekday" : days.map((d) => DAY_NAMES[d]).join(" and ");
    return `${title} ${when}${at}`;
  });
}

async function replayWeek(user: string, persona: string, weeks: number, k: number) {
  const p = personaById(persona)!;
  const batch = batches(persona, weeks)[k] ?? [];
  const t0 = Date.now() - (weeks - k) * WEEK_MS;
  const at = (hours: number) => new Date(t0 + hours * 3600000).toISOString();
  await update(user, (s) => {
    if (k === 0) activity(s, "Replay", `Replaying ${p.name}'s last ${weeks} weeks into ${s.name}'s log (demo).`);
    const have = new Set(s.events.map((e) => e.uid));
    const add = (i: Omit<Interaction, "id" | "source">) => s.interactions.push({ id: newId("i"), source: "sample", ...i, payload: { ...i.payload, replay: persona } });
    let created = 0;
    batch.forEach((e, j) => {
      const uid = `replay:${persona}:${e.id}`;
      if (have.has(uid)) return;
      const ev = { ...e, id: newId("e"), source: "sample" as const, uid };
      s.events.push(ev);
      add({ at: at(9 + j * 0.2), kind: "create", payload: { op: { op: "create", event: ev } } });
      created++;
    });
    // Jordan opens the week view on most visits; the others stay on whatever they had.
    const switches = persona === "jordan" ? [k === 2 ? DAY_ONE : WEEK_VIEW, WEEK_VIEW] : [];
    switches.forEach((to, n) => {
      add({ at: at(24 * (1 + 2 * n) + 9), kind: "view_switch", payload: { from: DAY_ONE, to, label: to === DAY_ONE ? "Month" : "Week" } });
      add({ at: at(24 * (1 + 2 * n) + 9.3), kind: "dwell", payload: { spec: to, seconds: 900 } });
    });
    activity(s, "Replay", `Week ${k + 1} of ${weeks}: ${p.name} added ${created} event${created === 1 ? "" : "s"}${switches.length ? ` and switched views ${switches.length} times` : ""}.`);
  });
  await runLearner(user, `Week ${k + 1}`);
  if (k === weeks - 1) await update(user, (s) => activity(s, "Replay", `Done replaying ${p.name}'s ${weeks} weeks.`));
}

async function replay(user: string, { persona, weeks, delayMs }: z.infer<typeof Replay>) {
  for (let k = 0; k < weeks; k++) {
    await replayWeek(user, persona, weeks, k);
    if (delayMs) await sleep(delayMs);
  }
}
