import { z } from "zod";
import { activity, getUser, update } from "../store";
import { isLive, structured } from "../llm";
import { systemFor } from "../prompts";
import { daysBetween, TODAY, weekday } from "../../src/shared/dates";
import type { Belief, CalEvent, Interaction, InteractionKind, UserState } from "../../src/shared/types";

// Habit learner (P8, E2): reads the interaction log and the events, never the UI, and keeps habit
// beliefs whose keys double as designer signals. Stats are computed in code; in live mode Nemotron
// Nano only rephrases them and nudges confidence a little.

const ROLE = "Habit learner";
const EVENT_KINDS: InteractionKind[] = ["create", "update", "delete", "import"];
const SCALES = ["day", "week", "month", "quarter", "year"] as const;
const REVERT = -0.25; // P10: revert is a strong negative
const DISMISS = -0.08; // dismiss a weak one
const KEEP = 0.05; // keeping an accepted view a positive one
const KEEP_MINUTES = 5;

type Value = Belief["value"];
type Candidate = {
  key: string;
  value: Value;
  statement: string;
  consistency: number; // 0..1: how cleanly the stats say it
  kinds: InteractionKind[]; // which interactions count as evidence
  weeks?: number; // weeks of history behind it; omitted for count-based beliefs
};

const minutesOf = (e: CalEvent) =>
  e.start.length > 10 ? (new Date(e.end).getTime() - new Date(e.start).getTime()) / 60000 : (daysBetween(e.start, e.end) + 1) * 1440;

function scaleOf(e: CalEvent): (typeof SCALES)[number] {
  const days = minutesOf(e) / 1440;
  return days <= 1 ? "day" : days <= 20 ? "week" : days < 90 ? "month" : days < 300 ? "quarter" : "year";
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
function fmtLength(min: number): string {
  if (min < 120) return plural(Math.round(min), "minute");
  if (min < 1440) return plural(Math.round(min / 60), "hour");
  const d = min / 1440;
  if (d < 14) return plural(Math.round(d), "day");
  if (d < 60) return plural(Math.round(d / 7), "week");
  if (d < 730) return plural(Math.round(d / 30.4), "month");
  return plural(Math.round(d / 365), "year");
}
const fmtHour = (h: number) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);
const spanWeeks = (days: string[]) => (days.length ? Math.max(1, Math.round((daysBetween(days[0], days.at(-1)!) + 1) / 7)) : 0);
const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];

const VIEW_NAMES: Record<string, string> = { WeekGrid: "week", MonthGrid: "month", YearBand: "years", WeekStrip: "52-week" };
function viewOf(i: Interaction): string | undefined {
  const spec = i.payload.to as { elements?: Record<string, { type: string }> } | undefined;
  const types = Object.values(spec?.elements ?? {}).map((e) => e.type);
  return types.map((t) => VIEW_NAMES[t]).find(Boolean);
}

// Candidate beliefs from plain statistics.
export function candidates(s: UserState): Candidate[] {
  const out: Candidate[] = [];
  const evs = s.events;
  if (evs.length >= 3) {
    const days = evs.map((e) => e.start.slice(0, 10)).sort();
    const weeks = spanWeeks(days);
    const past = spanWeeks(days.filter((d) => d <= TODAY)); // "in 14 weeks" means weeks lived, not planned
    const timed = evs.filter((e) => e.start.length > 10);
    const meetings = timed.filter((e) => minutesOf(e) <= 240);
    const meetingWeeks = spanWeeks(meetings.map((e) => e.start.slice(0, 10)).sort());
    const perWeek = meetings.length ? Math.round(meetings.length / meetingWeeks) : 0;

    const weekend = evs.filter((e) => weekday(e.start) >= 5).length;
    const share = weekend / evs.length;
    out.push(share <= 0.02
      ? { key: "weekendEvents", value: false, statement: weekend ? `Only ${weekend} of ${evs.length} events fall on a weekend` : past ? `No weekend events in ${plural(past, "week")}` : `None of ${evs.length} events fall on a weekend`, consistency: 1 - share * 15, kinds: EVENT_KINDS, weeks }
      : { key: "weekendEvents", value: true, statement: `Has weekend plans: ${weekend} of ${evs.length} events`, consistency: 0.85, kinds: EVENT_KINDS, weeks });

    if (meetings.length >= 3) {
      const short = meetings.filter((e) => minutesOf(e) >= 30 && minutesOf(e) <= 90).length / meetings.length;
      out.push({ key: "meetingsPerWeek", value: perWeek, statement: `About ${perWeek} meetings a week${short >= 0.7 ? ", mostly 30 to 90 minutes" : ""}`, consistency: 0.6 + 0.35 * short, kinds: EVENT_KINDS, weeks: meetingWeeks });
    }
    if (timed.length >= 5) {
      const from = Math.floor(quantile(timed.map((e) => Number(e.start.slice(11, 13)) + Number(e.start.slice(14, 16)) / 60), 0.1));
      const to = Math.ceil(quantile(timed.map((e) => Number(e.end.slice(11, 13)) + Number(e.end.slice(14, 16)) / 60), 0.97));
      const inside = timed.filter((e) => Number(e.start.slice(11, 13)) >= from && Number(e.end.slice(11, 13)) <= to).length / timed.length;
      out.push({ key: "workHours", value: `${from}-${to}`, statement: `Timed events fall between ${fmtHour(from)} and ${fmtHour(to)}`, consistency: inside, kinds: EVENT_KINDS, weeks });
    }

    const counts = Object.fromEntries(SCALES.map((k) => [k, evs.filter((e) => scaleOf(e) === k).length]));
    const scales = new Set(SCALES.filter((k) => counts[k] / evs.length >= 0.25));
    if (evs.some((e) => minutesOf(e) >= 365 * 1440)) scales.add("year");
    if (scales.has("year") && perWeek < 5) scales.delete("day"); // one-day items are milestones inside long plans
    if (perWeek >= 5) scales.add("week");
    const list = SCALES.filter((k) => scales.has(k));
    const shown = [...list].reverse().map((k) => `${k}s`);
    out.push({ key: "timeScales", value: list, statement: `Plans in ${shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0]}: ${evs.filter((e) => scales.has(scaleOf(e))).length} of ${evs.length} events`, consistency: 0.9, kinds: [...EVENT_KINDS, "view_switch"], weeks });

    out.push({ key: "typicalLength", value: fmtLength(quantile(evs.map(minutesOf), 0.5)), statement: `Median event lasts ${fmtLength(quantile(evs.map(minutesOf), 0.5))}`, consistency: 0.85, kinds: EVENT_KINDS, weeks });

    const ahead = daysBetween(TODAY, evs.map((e) => e.end.slice(0, 10)).sort().at(-1)!);
    const years = Math.round(ahead / 365);
    if (ahead >= 14) out.push({ key: "horizonYears", value: years, statement: years >= 1 ? `Plans reach ${plural(years, "year")} ahead` : `Plans reach about ${plural(Math.round(ahead / 7), "week")} ahead`, consistency: 0.85, kinds: EVENT_KINDS, weeks });
  }

  const switches = s.interactions.filter((i) => i.kind === "view_switch").slice(-20);
  const views = switches.map(viewOf).filter((v): v is string => !!v);
  if (views.length >= 2) {
    const top = mode(views);
    const n = views.filter((v) => v === top).length;
    if (n / views.length >= 0.5) out.push({ key: "preferredView", value: top, statement: `Chose the ${top} view ${n} of the last ${views.length} visits`, consistency: n / views.length, kinds: ["view_switch", "dwell"] });
  }

  const NAMES: Partial<Record<string, string>> = { typed: "typing", ics: ".ics import", text: "text files", email: "email", manual: "the calendar itself" };
  const added = s.interactions.filter((i) => (i.kind === "create" || i.kind === "import") && NAMES[i.source]).map((i) => i.source);
  if (added.length >= 3) {
    const top = mode(added);
    const n = added.filter((x) => x === top).length;
    out.push({ key: "sources", value: [...new Set(added)], statement: `Adds events mostly by ${NAMES[top]} (${n} of ${added.length})`, consistency: n / added.length, kinds: ["create", "import"] });
  }
  return out;
}

function mode(xs: string[]): string {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1])[0][0];
}

// A value the learner believed that the stats now say the opposite of (a counter-signal, E2).
// Counts, hours and lengths just drift; a flipped weekend habit, view or set of scales contradicts.
const CONTRADICTABLE = new Set(["weekendEvents", "preferredView", "timeScales"]);
const norm = (v: Value) => JSON.stringify(Array.isArray(v) ? [...v].sort() : v);
const contradicts = (key: string, a: Value, b: Value) => CONTRADICTABLE.has(key) && norm(a) !== norm(b);

// Index after which interactions count for a key: a deleted belief is only re-learned from new evidence.
const since = (s: UserState, key: string) => s.interactions.findLastIndex((i) => i.kind === "belief_deleted" && i.payload.key === key) + 1;

const reactionsFor = (s: UserState, key: string) =>
  s.interactions.slice(since(s, key)).filter((i) => (i.kind === "proposal_reverted" || i.kind === "proposal_dismissed" || i.kind === "proposal_accepted") && (i.payload.beliefKeys as string[] | undefined)?.includes(key));

type Change = { key: string; statement: string; from?: number; to: number };
export type LearnResult = { changes: Change[]; crossings: string[] };

type Plan = { beliefs: Belief[]; changes: Change[]; reactionConf: Record<string, Record<string, number>>; notes: string[] };

function plan(s: UserState, now: number): Plan {
  const at = new Date(now).toISOString();
  const beliefs: Belief[] = [];
  const changes: Change[] = [];
  const notes: string[] = [];
  const reactionConf: Plan["reactionConf"] = {};
  const cands = new Map(candidates(s).map((c) => [c.key, c]));
  const keys = new Set([...cands.keys(), ...s.beliefs.filter((b) => b.level === "habit").map((b) => b.key)]);

  for (const key of keys) {
    if (key.startsWith("meta.")) continue;
    const prev = s.beliefs.find((b) => b.key === key);
    const c = cands.get(key);
    const from = since(s, key);
    const relevant = c ? s.interactions.slice(from).filter((i) => c.kinds.includes(i.kind)) : [];
    if (!prev && !relevant.length) continue; // nothing new since it was deleted (or ever)
    const seen = new Set(prev?.evidence);
    const evidence = [...(prev?.evidence ?? [])];
    let conf = prev?.confidence ?? 0;
    let value = prev?.value ?? c!.value;
    let statement = prev?.statement ?? c!.statement;
    const notesFor: string[] = [];

    // Reactions to proposals that relied on this belief (P10).
    const reactions = reactionsFor(s, key);
    for (const r of reactions.filter((r) => !seen.has(r.id))) {
      const pid = r.payload.proposalId as string;
      let delta = r.kind === "proposal_reverted" ? REVERT : r.kind === "proposal_dismissed" ? DISMISS : 0;
      if (r.kind === "proposal_accepted") {
        const kept = s.proposals.find((p) => p.id === pid)?.status === "accepted" &&
          (now - new Date(r.at).getTime() >= KEEP_MINUTES * 60000 || s.interactions.some((d) => d.kind === "dwell" && d.at > r.at));
        if (!kept) continue;
        delta = KEEP;
      }
      if (delta < 0) (reactionConf[pid] ??= {})[key] = conf;
      const before = conf;
      conf = Math.min(0.97, Math.max(0, conf + delta));
      evidence.push(r.id);
      seen.add(r.id);
      const verb = r.kind === "proposal_reverted" ? "Undo of" : r.kind === "proposal_dismissed" ? "\"Not now\" on" : "Keeping";
      notesFor.push(`${verb} "${r.payload.title}" moves "${statement}" ${before.toFixed(2)} -> ${conf.toFixed(2)}`);
    }

    // New evidence pulls confidence toward what the stats support; no new evidence, no rise (E2).
    const fresh = relevant.filter((i) => !seen.has(i.id));
    if (c && fresh.length) {
      const reverts = reactions.filter((r) => r.kind === "proposal_reverted").length;
      const dismisses = reactions.filter((r) => r.kind === "proposal_dismissed").length;
      const penalty = Math.max(0.5, 1 - 0.15 * reverts - 0.05 * dismisses);
      const amount = c.weeks === undefined ? 1 - Math.exp(-relevant.length / 5) : (1 - Math.exp(-c.weeks / 4)) * Math.min(1, relevant.length / 6);
      const target = Math.max(0, 0.95 * c.consistency * amount * penalty);
      if (prev && contradicts(key, prev.value, c.value)) {
        conf = Math.max(0, conf - 0.15);
        if (conf < 0.3) {
          value = c.value;
          statement = c.statement;
          conf = target * 0.5;
          notesFor.push(`Changed its mind: "${c.statement}"`);
        } else notesFor.push(`Counter-signal for "${statement}": the log now says "${c.statement}"`);
      } else {
        conf += (target - conf) * (target > conf ? 0.6 : 0.5);
        value = c.value;
        statement = c.statement;
      }
      for (const i of fresh) evidence.push(i.id);
    }
    const next: Belief = { key, statement, value, confidence: Math.round(conf * 1000) / 1000, evidence, level: "habit", updatedAt: at };
    const moved = !prev || Math.abs(next.confidence - prev.confidence) >= 0.005 || next.statement !== prev.statement || evidence.length !== prev.evidence.length;
    if (!moved) continue;
    beliefs.push(next);
    if (!prev || Math.abs(next.confidence - prev.confidence) >= 0.005 || next.statement !== prev.statement) changes.push({ key, statement, from: prev?.confidence, to: next.confidence });
    notes.push(...notesFor);
  }
  return { beliefs, changes, reactionConf, notes };
}

const CORE = [
  "You are the habit learner of Evolve, a calendar that adapts its layout to how a person plans.",
  "You get habits already computed from the person's interaction log, each with a key, a value, a draft statement and a confidence.",
  "Rewrite each statement as one short plain-language line for the person's \"What I've learned\" panel, like \"No weekend events in 14 weeks\".",
  "Keep every number from the draft statement. Do not invent facts. Do not change keys or values.",
  "You may adjust a confidence by at most 0.1, down when the evidence looks thin or mixed, up when it is overwhelming.",
  'Reply with JSON only: {"beliefs": [{"key": "<key>", "statement": "<line>", "adjust": <number between -0.1 and 0.1>}]}',
].join("\n");
const Phrased = z.object({ beliefs: z.array(z.object({ key: z.string(), statement: z.string().min(3).max(160), adjust: z.number().min(-0.1).max(0.1) })) });

async function phrase(s: UserState, p: Plan): Promise<string | null> {
  const list = p.beliefs.filter((b) => p.changes.some((c) => c.key === b.key));
  if (!list.length) return null;
  try {
    const out = await structured(Phrased, systemFor(CORE, s, "habit"), JSON.stringify(list.map((b) => ({ key: b.key, value: b.value, statement: b.statement, confidence: b.confidence, evidence: b.evidence.length }))), { role: "router", temperature: 0.2 });
    for (const o of out.beliefs) {
      const b = list.find((x) => x.key === o.key);
      if (!b) continue;
      const nums = b.statement.match(/\d+/g) ?? [];
      if (nums.every((n) => o.statement.includes(n))) b.statement = o.statement;
      b.confidence = Math.round(Math.min(0.97, Math.max(0, b.confidence + o.adjust)) * 1000) / 1000;
      const ch = p.changes.find((c) => c.key === o.key)!;
      ch.statement = b.statement;
      ch.to = b.confidence;
    }
    return null;
  } catch (err) {
    return `Nemotron Nano unavailable (${(err as Error).message}); keeping the computed statements.`;
  }
}

// One learner pass. `label` prefixes the activity lines (the replay passes "Week 3").
export async function learn(userId: string, label?: string, now = Date.now()): Promise<LearnResult> {
  const s = getUser(userId);
  if (!s) throw new Error(`no such user: ${userId}`);
  const p = plan(s, now);
  if (!p.beliefs.length) return { changes: [], crossings: [] };
  const warn = isLive() ? await phrase(s, p) : null;
  const seenLog = s.interactions.length;
  const th = s.settings.threshold;

  return update(userId, (st) => {
    const prefix = label ? `${label}: ` : "";
    if (warn) activity(st, ROLE, warn);
    const crossings: string[] = [];
    const fell: Belief[] = [];
    const lines: string[] = [];
    for (const b of p.beliefs) {
      // Deleted while we were thinking: leave it deleted.
      if (st.interactions.slice(seenLog).some((i) => i.kind === "belief_deleted" && i.payload.key === b.key)) continue;
      const i = st.beliefs.findIndex((x) => x.key === b.key);
      const before = i >= 0 ? st.beliefs[i].confidence : 0;
      if (i >= 0) st.beliefs[i] = b;
      else st.beliefs.push(b);
      const ch = p.changes.find((c) => c.key === b.key);
      if (ch) lines.push(`${ch.statement} ${ch.from === undefined ? "(new)" : ch.from.toFixed(2)} -> ${ch.to.toFixed(2)}`);
      if (before < th && b.confidence >= th) crossings.push(b.key);
      if (before >= th && b.confidence < th) fell.push(b);
    }
    for (const n of p.notes) activity(st, ROLE, prefix + n);
    if (lines.length) activity(st, ROLE, `${prefix}Updated ${plural(lines.length, "belief")}: ${lines.join("; ")}.`);
    for (const key of crossings) {
      const b = st.beliefs.find((x) => x.key === key)!;
      activity(st, ROLE, `${prefix}"${b.statement}" crossed the ${th.toFixed(2)} threshold (${b.confidence.toFixed(2)}, ${plural(b.evidence.length, "piece")} of evidence).`);
    }
    for (const b of fell) activity(st, ROLE, `${prefix}"${b.statement}" fell below the ${th.toFixed(2)} threshold (${b.confidence.toFixed(2)}).`);
    for (const [pid, conf] of Object.entries(p.reactionConf)) {
      const prop = st.proposals.find((x) => x.id === pid);
      if (prop) prop.beliefConfidence = { ...conf, ...prop.beliefConfidence };
    }
    return { changes: p.changes, crossings };
  });
}
