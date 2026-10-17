import * as chrono from "chrono-node";
import { z } from "zod";
import { isLive, structured } from "../llm";
import { newId } from "../store";
import { systemFor } from "../prompts";
import { cached } from "../cache";
import { MODELS } from "../models";
import { addDays, daysBetween, mondayOf, MONTHS, TODAY, weekday } from "../../src/shared/dates";
import { overlaps } from "../../src/shared/ops";
import { fmtDate, fmtWhen } from "../../src/shared/when";
import type { CalEvent, ChangeSet, EventDraft, Operation, Precision, TraceStep, UserState } from "../../src/shared/types";

// The intent agent: a typed sentence or a pasted note becomes a ChangeSet. The model (or the
// offline parser) only writes steps with filters; code resolves every filter to concrete event
// ids before anything is shown or written (E12).

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const time = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, "YYYY-MM-DD or YYYY-MM-DDTHH:mm");
const Filter = z.object({
  from: day,
  to: day,
  titleContains: z.string().nullish(),
  category: z.string().nullish(),
  which: z.enum(["all", "next"]).nullish(),
});
const Step = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), title: z.string().min(1), start: time, end: time, category: z.string(), precision: z.enum(["exact", "approximate", "day", "week", "span"]) }),
  z.object({ op: z.literal("update"), filter: Filter, shiftDays: z.number().int().nullish(), timeOfDay: z.string().regex(/^\d{2}:\d{2}$/, "HH:mm").nullish(), start: time.nullish(), end: time.nullish(), title: z.string().nullish() }),
  z.object({ op: z.literal("delete"), filter: Filter }),
  z.object({ op: z.literal("query"), filter: Filter }),
]);
const Plan = z.object({ steps: z.array(Step) });
type Step = z.infer<typeof Step>;
type Filter = z.infer<typeof Filter>;

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SAT = addDays(mondayOf(TODAY), 5); // "this weekend" is the current or coming Sat-Sun

const CORE = `You turn what a person types or pastes into calendar operations. Today is ${WEEKDAYS[weekday(TODAY)]} ${TODAY}.
Reply with JSON only: {"steps": [...]}. Each step is one of:
- {"op":"create","title","start","end","category","precision"}
- {"op":"update","filter",<"shiftDays" | "timeOfDay":"HH:mm" (keeps the date) | "start"/"end" | "title">}
- {"op":"delete","filter"}
- {"op":"query","filter"} for questions such as "what's on Friday?"
A filter is {"from":"YYYY-MM-DD","to":"YYYY-MM-DD","titleContains"?,"category"?,"which"?:"all"|"next"}. It matches events overlapping from..to.
Rules:
1. Never invent event ids; describe what to change with a filter. Use "which":"next" when the person means one event ("move my dentist").
2. Keep vagueness (precision): "around noon" -> "approximate" with start YYYY-MM-DDT12:00; a time given -> "exact"; a date without time -> "day" (start = end = date); "sometime next week" -> "week" spanning Mon-Sun; "sometime in May", "year 2 to year 4" (company year 1 is ${TODAY.slice(0, 4)}) -> "span" over the whole period. All-day events have date-only start and end (end inclusive).
3. "This weekend" or "my weekend" is ${SAT} to ${addDays(SAT, 1)}. "Next week" as a move target means shiftDays 7.
4. Bulk wording ("empty out my weekend", "cancel everything Friday") is a delete with a date filter and no titleContains.
5. A note or email can imply several operations: emit every delete, move and add it implies, e.g. "empty out my weekend for a business trip" is a delete of everything that weekend plus a create of an all-day "Business trip" spanning it.
6. Timed events without an end last one hour. Pick a short category (Meetings, Health, Social, Travel, Personal, Work) or reuse one from the person's events.`;

// ---------- resolving steps to operations ----------

const lc = (s: string) => s.toLowerCase();
function titleHas(e: CalEvent, needle: string): boolean {
  const t = lc(e.title);
  const n = lc(needle).trim();
  if (!n) return true;
  const singular = n.replace(/s$/, "");
  return t.includes(n) || t.includes(singular) || singular.split(/\s+/).every((w) => t.includes(w));
}

function match(events: CalEvent[], f: Filter): CalEvent[] {
  const found = events
    .filter((e) => overlaps(e, f.from, f.to) && (!f.category || lc(e.category) === lc(f.category)))
    // A bare date range ("empty out my weekend") leaves alone long plans that merely span it.
    .filter((e) => (f.titleContains ? titleHas(e, f.titleContains) : !(e.start.slice(0, 10) < f.from && e.end.slice(0, 10) > f.to)))
    .sort((a, b) => a.start.localeCompare(b.start));
  return f.which === "next" ? found.slice(0, 1) : found;
}

const toDate = (s: string) => new Date(`${s.length > 10 ? s : `${s}T00:00`}:00Z`);
const minutesBetween = (a: string, b: string) => (toDate(b).getTime() - toDate(a).getTime()) / 60000;
const addMinutes = (s: string, n: number) => new Date(toDate(s).getTime() + n * 60000).toISOString().slice(0, 16);
const shift = (s: string, days: number) => addDays(s, days) + s.slice(10);

// Moves an event so it starts at `start`, keeping its length. A date-only target keeps the time of day.
function moveTo(e: CalEvent, start: string): Pick<CalEvent, "start" | "end"> {
  if (e.start.length <= 10) {
    const d = start.slice(0, 10);
    return { start: d, end: addDays(d, Math.round(minutesBetween(e.start, e.end) / 1440)) };
  }
  const s = start.length > 10 ? start : `${start}${e.start.slice(10)}`;
  return { start: s, end: addMinutes(s, minutesBetween(e.start, e.end)) };
}

function updated(e: CalEvent, st: Extract<Step, { op: "update" }>): CalEvent {
  let next: CalEvent = { ...e };
  if (st.shiftDays) next = { ...next, start: shift(e.start, st.shiftDays), end: shift(e.end, st.shiftDays) };
  if (st.start) next = { ...next, ...moveTo(e, st.start) };
  if (st.timeOfDay) next = { ...next, ...moveTo(next, `${next.start.slice(0, 10)}T${st.timeOfDay}`) };
  if (st.end) next.end = st.end.length > 10 || next.start.length <= 10 ? st.end : `${st.end}${next.start.slice(10)}`;
  if (st.title) next.title = st.title;
  return next;
}

function answerFor(events: CalEvent[], f: Filter): string {
  const found = match(events, { ...f, which: "all" });
  const wide = f.titleContains && daysBetween(f.from, f.to) > 31;
  const range = wide ? `"${f.titleContains}"` : f.from === f.to ? fmtDate(f.from) : `${fmtDate(f.from)} to ${fmtDate(f.to)}`;
  if (!found.length) return wide ? `Nothing matching "${f.titleContains}" on your calendar.` : `Nothing${f.titleContains ? ` for "${f.titleContains}"` : ""} on ${range}.`;
  const max = wide ? 5 : 12;
  const list = found.slice(0, max).map((e) => `${e.title} (${fmtWhen(e)})`).join("; ");
  return `${range}: ${list}${found.length > max ? `; and ${found.length - max} more` : ""}.`;
}

function summarize(ops: Operation[]): string {
  const by = (k: Operation["op"]) => ops.filter((o) => o.op === k);
  const name = (o: Operation) => (o.op === "create" ? o.event.title : o.before.title);
  const part = (verb: string, list: Operation[]) =>
    list.length === 0 ? [] : list.length === 1 ? [`${verb} "${name(list[0])}"`] : [`${verb} ${list.length} events`];
  const s = [...part("remove", by("delete")), ...part("move", by("update")), ...part("add", by("create"))].join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function resolve(state: UserState, steps: Step[], source: "typed" | "text"): ChangeSet {
  // Steps run in order against a working copy, so a later line can move or cancel an event an
  // earlier line of the same note added ("move the dog walk to Tuesday").
  const work = new Map(state.events.map((e) => [e.id, e]));
  const ops: (Operation | null)[] = [];
  const at = new Map<string, number>(); // event id (or temp id of a new event) -> index of its op
  const answers: string[] = [];
  steps.forEach((st, n) => {
    if (st.op === "query") {
      answers.push(answerFor([...work.values()], st.filter));
    } else if (st.op === "create") {
      const event: EventDraft = { title: st.title, start: st.start, end: st.end < st.start ? st.start : st.end, category: st.category, precision: st.precision, source };
      const id = `new-${n}`;
      work.set(id, { ...event, id });
      at.set(id, ops.push({ op: "create", event }) - 1);
    } else {
      for (const e of match([...work.values()], st.filter)) {
        const i = at.get(e.id);
        const next = st.op === "update" ? updated(e, st) : null;
        if (next) work.set(e.id, next);
        else work.delete(e.id);
        if (e.id.startsWith("new-")) {
          // Edits to an event this note adds just change (or drop) its create.
          ops[i!] = next ? { op: "create", event: { ...next, id: undefined } } : null;
          continue;
        }
        const before = state.events.find((x) => x.id === e.id)!;
        const op: Operation = next ? { op: "update", id: e.id, before, after: next } : { op: "delete", id: e.id, before };
        if (i === undefined) at.set(e.id, ops.push(op) - 1);
        else ops[i] = op;
      }
    }
  });
  return finish(steps, ops.filter((o): o is Operation => !!o), answers, source);
}

function finish(steps: Step[], ops: Operation[], answers: string[], source: "typed" | "text"): ChangeSet {
  const missed = steps.some((s) => s.op === "update" || s.op === "delete") && !ops.some((o) => o.op !== "create");
  if (!ops.length && !answers.length) answers.push(missed ? "No matching events found." : "I couldn't find anything to add or change in that.");
  return { id: newId("cs"), summary: ops.length ? summarize(ops) : steps.some((s) => s.op === "query") ? "Your calendar" : "Nothing to change", source, ops, ...(answers.length ? { answer: answers.join(" ") } : {}) };
}

// ---------- offline parser (mock mode, and the fallback when the model fails) ----------

type When = { from: string; to: string; start?: string; end?: string; precision: Precision; text: string[] };
const REF = () => new Date(Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7)) - 1, Number(TODAY.slice(8, 10)), 12);
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (c: chrono.ParsedComponents) => `${c.get("year")}-${pad(c.get("month")!)}-${pad(c.get("day")!)}`;
const hm = (c: chrono.ParsedComponents) => `${pad(c.get("hour")!)}:${pad(c.get("minute") ?? 0)}`;
const APPROX = /\b(around|about|roughly|approximately|ish)\b|-ish\b/i;
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function when(text: string): When | null {
  let m: RegExpMatchArray | null;
  if ((m = text.match(/\b(?:this |my |the )?(next )?weekend\b/i))) {
    const sat = m[1] ? addDays(SAT, 7) : SAT;
    return { from: sat, to: addDays(sat, 1), precision: "span", text: [m[0]] };
  }
  if ((m = text.match(/\b(?:some ?time )?(this|next) week\b/i))) {
    const mon = addDays(mondayOf(TODAY), lc(m[1]) === "next" ? 7 : 0);
    return { from: mon, to: addDays(mon, 6), precision: "week", text: [m[0]] };
  }
  if ((m = text.match(/\b(?:from )?years? (\d+) (?:to|through|until|-) (?:year )?(\d+)\b/i))) {
    const y1 = Number(TODAY.slice(0, 4)) - 1;
    return { from: `${y1 + Number(m[1])}-01-01`, to: `${y1 + Number(m[2])}-12-31`, precision: "span", text: [m[0]] };
  }
  if ((m = text.match(new RegExp(`\\b(?:some ?time )?(?:in )?(${MONTH_NAMES.join("|")}|${MONTHS.join("|")})\\b(?! \\d)`, "i"))) && !/\bmay i\b/i.test(text)) {
    const idx = MONTH_NAMES.findIndex((n) => n.startsWith(lc(m![1]).slice(0, 3)));
    const year = Number(TODAY.slice(0, 4)) + (idx + 1 < Number(TODAY.slice(5, 7)) ? 1 : 0);
    const from = `${year}-${pad(idx + 1)}-01`;
    const last = new Date(Date.UTC(year, idx + 1, 0)).getUTCDate();
    return { from, to: `${year}-${pad(idx + 1)}-${pad(last)}`, precision: "span", text: [m[0]] };
  }
  const results = chrono.parse(text, REF(), { forwardDate: true });
  if (!results.length) return null;
  const dated = results.find((r) => r.start.isCertain("day") || r.start.isCertain("weekday"));
  const timed = results.find((r) => r.start.isCertain("hour"));
  const date = ymd((dated ?? results[0]).start);
  const out: When = { from: date, to: date, precision: "day", text: results.map((r) => r.text) };
  if (timed) {
    out.start = `${date}T${hm(timed.start)}`;
    out.end = timed.end?.isCertain("hour") ? `${date}T${hm(timed.end)}` : addMinutes(out.start, 60);
    out.precision = APPROX.test(text) ? "approximate" : "exact";
  }
  return out;
}

function strip(text: string, w: When | null): string {
  let t = text;
  for (const piece of w?.text ?? []) t = t.replace(piece, " ");
  return t
    .replace(/\b(around|roughly|approximately)\b|-?ish\b/gi, " ")
    .replace(/'s\b/g, "")
    .replace(/^[\s,;:-]+|[\s.!?,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/(\s(on|at|in|for|by|from|to|about|some ?time|the|my))+\s*$/i, "")
    .trim();
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const CATEGORIES: [RegExp, string][] = [
  [/dentist|doctor|physio|therap|gym|run\b|yoga|checkup|clinic/i, "Health"],
  [/standup|meeting|sync|review|call|1:1|interview|demo|planning/i, "Meetings"],
  [/trip|flight|travel|vacation|hotel|conference/i, "Travel"],
  [/lunch|dinner|coffee|drinks|breakfast|party|birthday/i, "Social"],
];
const category = (title: string) => CATEGORIES.find(([re]) => re.test(title))?.[1] ?? "Personal";

const QUESTION_WORDS = new Set("what what's whats when when's is are do does i have has there anything any show me list how many where on my the events event planned scheduled happening going calendar".split(" "));
const QUESTION = /^(what|what's|whats|when|when's|do i|am i|is there|anything|show|list|how many|where)\b|\?\s*$/i;
const DELETE = /\b(cancel|delete|remove|drop|skip|clear(?: out)?|empty out|free up|scrap|call off|can't make|won't make)\b/i;
const MOVE = /\b(move|reschedule|push|shift|postpone|bump|change)\b/i;
const FILLER = /^(?:(?:please|can you|could you|i need to|i have to|i want to|i'd like to|let's|lets|need to|have to|add|schedule|book|put|create|set up|plan|i have|i've got|there's|a|an|the|my|our)\s+)+/i;
const WIDE = () => ({ from: TODAY, to: addDays(TODAY, 365) });
const clause = (s: string, at: number) => s.slice(at).split(/,|;| because | since | so that | as /i)[0];

function parseSentence(sentence: string, allowQuery: boolean): Step[] {
  const s = sentence.trim();
  if (!s) return [];
  if (QUESTION.test(s)) {
    if (!allowQuery) return [];
    const w = when(s);
    const title = strip(s, w).split(/\s+/).filter((x) => x !== "a" && !QUESTION_WORDS.has(lc(x))).join(" ");
    return [{ op: "query", filter: { ...(w ? { from: w.from, to: w.to } : title ? { from: addDays(TODAY, -60), to: addDays(TODAY, 365) } : { from: TODAY, to: TODAY }), titleContains: title || null } }];
  }
  const del = s.match(DELETE);
  if (del) {
    const part = clause(s, del.index!);
    const reason = part.match(/\bfor (?:a |an |the |my )?(.+)$/i);
    const body = (reason ? part.slice(0, reason.index) : part).slice(del[0].length);
    const w = when(body) ?? when(part);
    const title = strip(body, w).replace(FILLER, "").replace(/^(everything|all|all events|anything)\b/i, "").trim();
    const steps: Step[] = [{ op: "delete", filter: { ...(w ? { from: w.from, to: w.to } : WIDE()), titleContains: title || null, which: w ? "all" : "next" } }];
    // "empty out my weekend for a business trip": the reason becomes the event that takes its place.
    if (reason && w && !title) {
      const t = cap(strip(reason[1], null));
      steps.push({ op: "create", title: t, start: w.from, end: w.to, category: category(t), precision: w.from === w.to ? "day" : "span" });
    }
    return steps;
  }
  const mv = s.match(MOVE);
  if (mv) {
    const part = clause(s, mv.index! + mv[0].length);
    const by = part.match(/\b(?:back|forward|later|out|by)\s+(?:by\s+)?(a|one|two|three|\d+)\s+(day|week)s?\b/i);
    const split = part.match(/\s(?:to|until|till|for)\s/i);
    const object = by ? part.slice(0, by.index) : split ? part.slice(0, split.index) : part;
    const target = !by && split ? part.slice(split.index! + split[0].length) : "";
    const ow = when(object);
    const title = strip(object, ow).replace(FILLER, "").trim();
    const filter: Filter = { ...(ow ? { from: ow.from, to: ow.to } : WIDE()), titleContains: title || null, which: ow && title ? "all" : "next" };
    if (by) {
      const n = { a: 1, one: 1, two: 2, three: 3 }[lc(by[1]) as "a"] ?? Number(by[1]);
      return [{ op: "update", filter, shiftDays: n * (lc(by[2]) === "week" ? 7 : 1) * (/forward/i.test(by[0]) ? -1 : 1) }];
    }
    if (/\bnext week\b/i.test(target)) return [{ op: "update", filter, shiftDays: 7 }];
    const tw = target ? when(target) : null;
    if (!tw) return /postpone/i.test(mv[0]) ? [{ op: "update", filter, shiftDays: 7 }] : [];
    const timeOnly = !!tw.start && !chrono.parse(target, REF()).some((r) => r.start.isCertain("day") || r.start.isCertain("weekday"));
    return [timeOnly ? { op: "update", filter, timeOfDay: tw.start!.slice(11) } : { op: "update", filter, start: tw.start ?? tw.from }];
  }
  const w = when(s);
  if (!w) return [];
  const title = cap(strip(s, w).replace(FILLER, "")).trim();
  if (!title) return [];
  const start = w.start ?? w.from;
  return [{ op: "create", title, start, end: w.end ?? w.to, category: category(title), precision: w.precision }];
}

export function parseOffline(text: string, source: "typed" | "text"): Step[] {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((x) => x.replace(/^[-*•\d.)\s]+/, "").trim()).filter(Boolean);
  return sentences.flatMap((x) => parseSentence(x, source === "typed" || sentences.length === 1));
}

// ---------- entry point ----------

function eventsForPrompt(state: UserState): string {
  const near = state.events.filter((e) => overlaps(e, addDays(TODAY, -14), addDays(TODAY, 120))).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 150);
  return near.map((e) => `${e.title} | ${e.start} | ${e.end} | ${e.category}`).join("\n") || "(no events)";
}

export async function parseIntent(state: UserState, text: string, source: "typed" | "text"): Promise<{ changeSet: ChangeSet; trace: TraceStep[]; query: boolean }> {
  const trace: TraceStep[] = [];
  let steps: Step[] | null = null;
  if (isLive()) {
    try {
      const prompt = `${source === "text" ? "Pasted text" : "Typed sentence"}:\n${text}\n\nTheir events near today (title | start | end | category):\n${eventsForPrompt(state)}`;
      // The plan holds filters, not event ids, so the same words replay correctly against today's events.
      const out = await cached([MODELS.intent, source, text.trim()], async () =>
        (await structured(Plan, systemFor(CORE, state, "intent"), prompt, { role: "intent", temperature: 0.1 })).steps);
      steps = out.value;
      if (out.hit) trace.push({ role: "Intent", text: "Reused the cached plan for this text." });
    } catch (err) {
      trace.push({ role: "Intent", text: `Model failed (${(err as Error).message}); used the offline parser instead.` });
    }
  }
  steps ??= parseOffline(text, source);
  const changeSet = resolve(state, steps, source);
  const quoted = text.length > 80 ? `${text.slice(0, 77).replace(/\s+/g, " ")}...` : text;
  trace.push({ role: "Intent", text: `Read "${quoted}" as ${steps.length} step${steps.length === 1 ? "" : "s"} (${steps.map((x) => x.op).join(", ") || "none"}); resolved to ${changeSet.ops.length} operation${changeSet.ops.length === 1 ? "" : "s"}${isLive() ? "" : " (offline parser)"}.` });
  return { changeSet, trace, query: steps.some((x) => x.op === "query") };
}
