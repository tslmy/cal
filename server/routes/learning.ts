import type { Express } from "express";
import { z } from "zod";
import { activity, DAY_ONE, getUser, log, newId, update } from "../store";
import { runLearner } from "../loop";
import { personaById } from "../../src/shared/personas";
import { mondayOf, TODAY } from "../../src/shared/dates";
import type { CalendarSpec } from "../../src/shared/catalog";
import type { Interaction } from "../../src/shared/types";

const Settings = z.object({ proposalsOn: z.boolean().optional(), minGapMinutes: z.number().int().min(0).max(10080).optional() });
const Replay = z.object({ persona: z.enum(["jordan", "mina", "sam"]), weeks: z.number().int().min(1).max(26).default(8), delayMs: z.number().int().min(0).max(5000).default(1200), wait: z.boolean().default(false) });

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
  app.post("/api/learning/:user/replay", async (req, res) => {
    const body = Replay.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: body.error.issues[0].message });
    if (!getUser(req.params.user)) return res.status(404).json({ error: "no such user" });
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

async function replay(user: string, { persona, weeks, delayMs }: z.infer<typeof Replay>) {
  const p = personaById(persona)!;
  // Someone with a dense calendar adds events as the weeks come; a long-range planner adds plans in no
  // particular date order, so their weeks get an even mix.
  const sorted = [...p.events].sort((a, b) => a.start.localeCompare(b.start));
  const dense = sorted.length >= weeks * 5;
  const weekOf = (i: number) => (dense ? Math.floor((i * weeks) / sorted.length) : i % weeks);
  const start = Date.now() - weeks * WEEK_MS;
  await update(user, (s) => activity(s, "Replay", `Replaying ${p.name}'s last ${weeks} weeks into ${s.name}'s log (demo).`));
  for (let k = 0; k < weeks; k++) {
    const t0 = start + k * WEEK_MS;
    const at = (hours: number) => new Date(t0 + hours * 3600000).toISOString();
    const batch = sorted.filter((_, i) => weekOf(i) === k);
    await update(user, (s) => {
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
    if (delayMs) await sleep(delayMs);
  }
  await update(user, (s) => activity(s, "Replay", `Done replaying ${p.name}'s ${weeks} weeks.`));
}
