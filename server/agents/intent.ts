import * as chrono from "chrono-node";
import { z } from "zod";
import { isLive, structured } from "../llm";
import { newId } from "../store";
import { systemFor } from "../prompts";
import { cached } from "../cache";
import { MODELS } from "../models";
import { addDays, DAY_KEYS, daysBetween, mondayOf, MONTHS, TODAY, weekday, type DayKey } from "../../src/shared/dates";
import { overlaps } from "../../src/shared/ops";
import { fmtDate, fmtWhen } from "../../src/shared/when";
import type { CalEvent, ChangeSet, EventDraft, Operation, Precision, TraceStep, UserState } from "../../src/shared/types";

// The intent agent: a typed sentence or a pasted note becomes a ChangeSet. The model (or the
// offline parser) only writes steps with filters; code resolves every filter to concrete event
// ids before anything is shown or written (E12).

// tidyPlan below trims seconds; date-only fields also drop a time ("2026-10-24T00:00" -> "2026-10-24").
const day = z.string().transform((s) => (/^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s)).pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"));
const time = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, "YYYY-MM-DD or YYYY-MM-DDTHH:mm");
const Filter = z.object({
  from: day,
  to: day,
  titleContains: z.string().nullish(),
  category: z.string().nullish(),
  which: z.enum(["all", "next"]).nullish(),
});
const Repeat = z.object({ days: z.array(z.enum(DAY_KEYS)).min(1), until: day.nullish() });
const Step = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), title: z.string().min(1), start: time, end: time, category: z.string(), precision: z.enum(["exact", "approximate", "day", "week", "span"]), repeat: Repeat.nullish() }),
  z.object({ op: z.literal("update"), filter: Filter, shiftDays: z.number().int().nullish(), timeOfDay: z.string().regex(/^\d{2}:\d{2}$/, "HH:mm").nullish(), start: time.nullish(), end: time.nullish(), title: z.string().nullish() }),
  z.object({ op: z.literal("delete"), filter: Filter }),
  z.object({ op: z.literal("query"), filter: Filter }),
]);
// Fixes the near misses models make before validating, so they don't cost a retry or fall back
// to the offline parser: a bare array or one step instead of {steps}, op synonyms ("add",
// "move", "cancel"), "" for unused fields, seconds on times, numbers as strings, Mon-style days
// and a missing category or precision.
const OPS: Record<string, string> = { add: "create", new: "create", insert: "create", move: "update", edit: "update", change: "update", reschedule: "update", remove: "delete", cancel: "delete", find: "query", list: "query", read: "query" };
const clean = (v: unknown): unknown => {
  if (v === "" || v === "null") return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(v)) return v.slice(0, 10) + "T" + v.slice(11, 16);
  if (typeof v === "string" && /^\d{2}:\d{2}:\d{2}$/.test(v)) return v.slice(0, 5);
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
  return v;
};
function tidyPlan(raw: unknown): unknown {
  const r = clean(raw) as Record<string, unknown> | unknown[] | null;
  const steps = Array.isArray(r) ? r : r && Array.isArray(r.steps) ? r.steps : r && typeof r === "object" && "op" in r ? [r] : r && typeof r === "object" ? (Object.values(r).find(Array.isArray) ?? []) : [];
  return {
    steps: (steps as Record<string, unknown>[]).filter((x) => x && typeof x === "object").map((x) => {
      const op = String(x.op ?? x.action ?? x.type ?? "").toLowerCase();
      const st: Record<string, unknown> = { ...x, op: OPS[op] ?? op };
      if (typeof st.shiftDays === "string") st.shiftDays = Number(st.shiftDays);
      if (st.op === "create") {
        st.category ??= "Personal";
        st.precision ??= String(st.start ?? "").length > 10 ? "exact" : "day";
        st.end ??= st.start;
        const rep = st.repeat as { days?: unknown } | null | undefined;
        if (rep && Array.isArray(rep.days)) rep.days = rep.days.map((d) => String(d).slice(0, 3).toLowerCase());
      }
      const f = st.filter as Record<string, unknown> | null | undefined;
      if (f && typeof f === "object") {
        f.to ??= f.from;
        if (f.which && f.which !== "all" && f.which !== "next") f.which = null;
      }
      return st;
    }),
  };
}
const Plan = z.preprocess(tidyPlan, z.object({ steps: z.array(Step) }));
type Step = z.infer<typeof Step>;
type Filter = z.infer<typeof Filter>;

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SAT = addDays(mondayOf(TODAY), 5); // "this weekend" is the current or coming Sat-Sun
// Models are unreliable at weekday arithmetic, so the prompt spells out the next two weeks.
const DATES = Array.from({ length: 15 }, (_, i) => addDays(TODAY, i))
  .map((d, i) => `${WEEKDAYS[weekday(d)].slice(0, 3)} ${d}${i === 0 ? " (today)" : ""}`)
  .join(", ");
// A repeating event without an end date is filled in this far ahead.
const REPEAT_WEEKS = 12;

const CORE = `You turn what a person types or pastes into calendar operations. Today is ${WEEKDAYS[weekday(TODAY)]} ${TODAY}.
The next two weeks: ${DATES}.
Reply with JSON only: {"steps": [...]}. Each step is one of:
- {"op":"create","title","start","end","category","precision","repeat"?}
- {"op":"update","filter",<"shiftDays" | "timeOfDay":"HH:mm" (keeps the date) | "start"/"end" | "title">}
- {"op":"delete","filter"}
- {"op":"query","filter"} for questions such as "what's on Friday?"
A filter is {"from":"YYYY-MM-DD","to":"YYYY-MM-DD","titleContains"?,"category"?,"which"?:"all"|"next"}. It matches events overlapping from..to.
Rules:
1. Never invent event ids; describe what to change with a filter. Use "which":"next" when the person means one event ("move my dentist").
2. Keep vagueness (precision): "around", "about", "roughly", "-ish" or "or so" next to a time -> "approximate" ("around 7pm" -> start YYYY-MM-DDT19:00, precision "approximate"); a plain time -> "exact"; a date without time -> "day" (start = end = date); "sometime next week" -> "week" spanning Mon-Sun; "sometime in May", "year 2 to year 4" (company year 1 is ${TODAY.slice(0, 4)}) -> "span" over the whole period. All-day events have date-only start and end (end inclusive).
3. Take every date from the list of the next two weeks above; never work out a weekday yourself. A bare weekday ("Monday", "on Thursday", "this Friday") is its first date after today in that list; "next <weekday>" is the one in the week starting ${addDays(mondayOf(TODAY), 7)}. "This weekend" or "my weekend" is ${SAT} to ${addDays(SAT, 1)}. "Next week" as a move target means shiftDays 7.
4. Bulk wording ("empty out my weekend", "cancel everything Friday") is a delete with a date filter and no titleContains.
5. A note or email can imply several operations: emit every delete, move and add it implies, e.g. "empty out my weekend for a business trip" is a delete of everything that weekend plus a create of an all-day "Business trip" spanning it.
6. Timed events without an end last one hour, approximate ones too: end is always after start. Overnight events end the next day ("7pm to 7am" Monday ends Tuesday 07:00). Pick a short category (Meetings, Health, Social, Travel, Personal, Work) or reuse one from the person's events.
7. Repeating events ("every Tue and Thu", "Saturdays", "every evening", "weekly on Friday") are one create for the first occurrence with "repeat":{"days":["tue","thu"],"until":"YYYY-MM-DD" or null}. Every day is all seven days; weekdays are mon to fri. Code fills in the occurrences.
8. Only change events the text asks to change. Context or remarks about the future ("next week the rotation flips", "I'm on nights now") delete and move nothing; add only events they spell out. Giving away, swapping or getting cover for one shift deletes just that day's shift: a filter with from = to = that date, titleContains, "which":"next".`;

// ---------- resolving steps to operations ----------

const lc = (s: string) => s.toLowerCase();
function titleHas(e: CalEvent, needle: string): boolean {
  const t = lc(e.title);
  const n = lc(needle).trim();
  if (!n) return true;
  const singular = n.replace(/s$/, "");
  // Words match from their start, so "it" doesn't find "Lunch with Mom" and "shift" doesn't find "shifted".
  const word = (w: string) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t);
  return word(n) || word(singular) || singular.split(/\s+/).every(word);
}

// A timed event shorter than a day belongs to the day it starts, so "Thursday's shift" never
// picks up Wednesday's overnight shift that ends Thursday morning.
const onDays = (e: CalEvent, from: string, to: string) =>
  e.start.length > 10 && minutesBetween(e.start, e.end) < 1440 ? e.start.slice(0, 10) >= from && e.start.slice(0, 10) <= to : overlaps(e, from, to);

function match(events: CalEvent[], f: Filter): CalEvent[] {
  const found = events
    .filter((e) => onDays(e, f.from, f.to) && (!f.category || lc(e.category) === lc(f.category)))
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
    list.length === 0 ? [] : new Set(list.map(name)).size === 1 ? [`${verb} "${name(list[0])}"${list.length > 1 ? ` (${list.length} times)` : ""}`] : [`${verb} ${list.length} events`];
  const s = [...part("remove", by("delete")), ...part("move", by("update")), ...part("add", by("create"))].join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Timed events always end after they start: an end earlier on the same day is overnight, and a
// missing or zero length becomes one hour.
function span(start: string, end: string): Pick<CalEvent, "start" | "end"> {
  if (start.length <= 10) return { start, end: end.slice(0, 10) < start ? start : end.slice(0, 10) };
  let e = end.length > 10 ? end : `${end}${start.slice(10)}`;
  if (e < start && e.slice(0, 10) === start.slice(0, 10)) e = `${addDays(e.slice(0, 10), 1)}${e.slice(10)}`;
  return { start, end: e <= start ? addMinutes(start, 60) : e };
}

// A repeating create becomes one event per matching day from its start, up to `until` or REPEAT_WEEKS.
function occurrences(first: EventDraft, repeat: z.infer<typeof Repeat> | null | undefined): EventDraft[] {
  if (!repeat) return [first];
  const d0 = first.start.slice(0, 10);
  const last = repeat.until && repeat.until >= d0 ? repeat.until : addDays(d0, REPEAT_WEEKS * 7 - 1);
  const len = daysBetween(d0, first.end.slice(0, 10));
  const recurrence = `FREQ=WEEKLY;BYDAY=${repeat.days.map((x) => x.slice(0, 2).toUpperCase()).join(",")}${repeat.until ? `;UNTIL=${repeat.until.replace(/-/g, "")}` : ""}`;
  const out: EventDraft[] = [];
  for (let d = d0; d <= last; d = addDays(d, 1)) {
    if (!repeat.days.includes(DAY_KEYS[weekday(d)])) continue;
    out.push({ ...first, start: d + first.start.slice(10), end: addDays(d, len) + first.end.slice(10), recurrence });
  }
  return out.length ? out : [first];
}

// The same event added twice ("bake cookies next Saturday" after moving the cookies there, or a
// picked-up shift the rotation already added): same day, one title contained in the other, and
// starting within two hours when both are timed.
function same(e: CalEvent, d: EventDraft): boolean {
  if (e.start.slice(0, 10) !== d.start.slice(0, 10)) return false;
  if (!titleHas(e, d.title.replace(/\b(bake|do|make|go to|have|picked up|an extra|extra)\b/gi, " ")) && !titleHas({ ...e, title: d.title }, e.title)) return false;
  return e.start.length <= 10 || d.start.length <= 10 || Math.abs(minutesBetween(e.start, d.start)) <= 120;
}

export function resolve(state: UserState, steps: Step[], source: "typed" | "text"): ChangeSet {
  // Steps run in order against a working copy, so a later line can move or cancel an event an
  // earlier line of the same note added ("move the dog walk to Tuesday").
  const work = new Map(state.events.map((e) => [e.id, e]));
  const ops: (Operation | null)[] = [];
  const at = new Map<string, number>(); // event id (or temp id of a new event) -> index of its op
  const answers: string[] = [];
  const skipped: string[] = [];
  steps.forEach((st, n) => {
    if (st.op === "query") {
      answers.push(answerFor([...work.values()], st.filter));
    } else if (st.op === "create") {
      const first: EventDraft = { title: st.title, ...span(st.start, st.end), category: st.category, precision: st.precision, source };
      occurrences(first, st.repeat).forEach((event, k) => {
        const twin = [...work.values()].find((e) => same(e, event));
        if (twin) return void skipped.push(`"${twin.title}" is already on ${fmtWhen(twin)}`);
        const id = `new-${n}-${k}`;
        work.set(id, { ...event, id });
        at.set(id, ops.push({ op: "create", event }) - 1);
      });
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
  if (skipped.length) answers.push(`Skipped ${skipped.length === 1 ? "an event" : `${skipped.length} events`} already on the calendar: ${skipped.slice(0, 3).join("; ")}${skipped.length > 3 ? "; and more" : ""}.`);
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
// Only next to a time: "about my refill" or "strict about that" is not a rough time.
const APPROX = /\b(around|about|roughly|approximately)\s+(\d|noon|midnight)|\d\s*(am|pm)?-?ish\b|\bor so\b/i;
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
  // A bare "night" or "morning" is part of a title ("night shift"), not a time.
  const results = chrono.parse(text, REF(), { forwardDate: true }).filter((r) => !/^(night|morning|evening|afternoon)$/i.test(r.text));
  if (!results.length) return null;
  // "Thursday the 29th": the day of the month wins over the weekday.
  const dated = results.find((r) => r.start.isCertain("day")) ?? results.find((r) => r.start.isCertain("weekday"));
  const timed = results.find((r) => r.start.isCertain("hour"));
  // chrono skips "the 29th": take that day of this month, or next month once it has passed.
  const nth = text.match(/\bthe (\d{1,2})(?:st|nd|rd|th)\b/i);
  const nthDate = nth && !dated?.start.isCertain("day") ? [TODAY.slice(0, 8), addDays(`${TODAY.slice(0, 7)}-01`, 31).slice(0, 8)].map((m) => `${m}${pad(Number(nth[1]))}`).find((d) => d >= TODAY) : null;
  const date = nthDate ?? ymd((dated ?? results[0]).start);
  const out: When = { from: date, to: date, precision: "day", text: [...results.map((r) => r.text), ...(nthDate ? [nth![0]] : [])] };
  // "November 16 to November 22" is one result with an end date.
  const until = dated?.end?.isCertain("day") ? ymd(dated.end) : null;
  if (until && until > date && !timed) Object.assign(out, { to: until, precision: "span" });
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
    .replace(/(\s(on|at|in|for|by|from|to|about|some ?time|the|my|and))+\s*$/i, "")
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
const DELETE = /\b(cancel(?:l?ed)?|delete|remove|drop(?!-off)|skip|clear(?: out)?|empty out|free up|scrap|call off|can't make|won't make|gave away|give away|giving away)\b/i;
const DAY_WORD = /\b(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs?(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?\b/gi;
// "every night shift" and "every day off" name events, not a schedule.
const EVERY = /\bevery\s+(day|evening|morning|night|weekday|weeknight)s?\b(?!\s+(?:shift|off)\b)|\b(?:every|each)\b(?=\s+(?:mon|tue|wed|thu|fri|sat|sun))/i;
const PLURAL_DAY = /\b(mon|tues|wednes|thurs|fri|satur|sun)days\b/i;

// "every Tue/Thu", "Saturdays", "every evening": the days a sentence repeats on, if any.
function repeatOf(s: string): { days: DayKey[]; rest: string } | null {
  const every = s.match(EVERY);
  if (!every && !PLURAL_DAY.test(s)) return null;
  const unit = every?.[1] ? lc(every[1]) : null;
  const named = [...s.matchAll(DAY_WORD)].map((m) => DAY_KEYS.find((k) => lc(m[1]).startsWith(k))!).filter(Boolean);
  const days = unit === "weekday" || unit === "weeknight" ? DAY_KEYS.slice(0, 5) : unit ? [...DAY_KEYS] : [...new Set(named)];
  if (!days.length) return null;
  const rest = s.replace(EVERY, ({ morning: " at 8am", evening: " at 7pm", night: " at 9pm" } as Record<string, string>)[unit ?? ""] ?? " ").replace(DAY_WORD, " ").replace(/\s+(?:and|&|\/|,)\s+/g, " ").replace(/\s+/g, " ");
  return { days: DAY_KEYS.filter((k) => days.includes(k)), rest };
}
// "shift" only as the opening verb, so "night shift Monday" is an event, not a move.
// "change" only as a verb ("change it to", "change my"), not "oil change".
const MOVE = /\b(move[sd]?|reschedule|push|postpone|bump)\b|\bchange\s+(?:the|my|it|to)\b|^shift\b/i;
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
    let title = strip(body, w).replace(FILLER, "").replace(/^(everything|all|all events|anything)\b/i, "").trim();
    // "Ava's soccer is cancelled this Thursday": the event is named before the verb.
    if (!title && !/\b(everything|all|anything)\b/i.test(body)) title = strip(s.slice(0, del.index).split(/[,.;]/).at(-1)!.replace(/\b(is|are|was|were|got|has been|have been)\s*$/i, ""), w).replace(FILLER, "").trim();
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
  const rep = repeatOf(s);
  const text = rep?.rest ?? s;
  const w = when(text) ?? (rep ? { from: TODAY, to: TODAY, precision: "day" as const, text: [] } : null);
  if (!w) return [];
  const title = cap(strip(text, w).replace(FILLER, "")).trim();
  if (!title) return [];
  const start = w.start ?? w.from;
  return [{ op: "create", title, start, end: w.end ?? w.to, category: category(title), precision: w.precision, repeat: rep && { days: rep.days, until: null } }];
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
      const system = systemFor(CORE, state, "intent");
      // The plan holds filters, not event ids, so the same words replay correctly against today's
      // events. An exact hit needs the same model and prompt; failing that, any earlier plan for the
      // same words is reused, including ones cached under the gpt-oss model used before.
      const out = await cached([MODELS.intent, source, text.trim(), system], async () =>
        (await structured(Plan, system, prompt, { role: "intent", temperature: 0.1 })).steps,
        [[source, text.trim()], ["openai/gpt-oss-120b", source, text.trim()]]);
      steps = out.value;
      if (out.hit) trace.push({ role: "Intent", text: "Reused the cached plan for this text." });
    } catch (err) {
      trace.push({ role: "Intent", text: `Model failed (${(err as Error).message}); used the offline parser instead.` });
    }
  }
  steps ??= parseOffline(text, source);
  // Models often mark "around 7pm" as exact. For one typed sentence the wording settles it.
  if (source === "typed" && APPROX.test(text) && steps.length === 1 && steps[0].op === "create" && steps[0].precision === "exact") steps = [{ ...steps[0], precision: "approximate" }];
  const changeSet = resolve(state, steps, source);
  const quoted = text.length > 80 ? `${text.slice(0, 77).replace(/\s+/g, " ")}...` : text;
  trace.push({ role: "Intent", text: `Read "${quoted}" as ${steps.length} step${steps.length === 1 ? "" : "s"} (${steps.map((x) => x.op).join(", ") || "none"}); resolved to ${changeSet.ops.length} operation${changeSet.ops.length === 1 ? "" : "s"}${isLive() ? "" : " (offline parser)"}.` });
  return { changeSet, trace, query: steps.some((x) => x.op === "query") };
}
