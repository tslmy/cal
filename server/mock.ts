import { isNovel, type CalendarSpec } from "../src/shared/catalog";
import type { DesignRequest, Persona } from "../src/shared/types";
import { addDays, DAY_KEYS, TODAY } from "../src/shared/dates";
import { focusWeek, mustShow } from "../src/shared/critic";

// Offline stand-in for the model, used when no CRUSOE_API_KEY is set.
// Some first drafts are deliberately flawed so the critic and repair loop have something to catch.

type El = CalendarSpec["elements"][string];
const leaf = (type: string, props: Record<string, unknown>): El => ({ type, props, children: [] });
const one = (el: El): CalendarSpec => ({ root: "view", elements: { view: el } });

// The week views are asked to show: next week on a weekend, as the critic expects.
const WEEK = focusWeek();
const ALL = [...DAY_KEYS];
const WORK = ALL.slice(0, 5);

function hybrid(strips: number[], band: [number, number] | null): CalendarSpec {
  const elements: CalendarSpec["elements"] = {};
  const top: string[] = [];
  if (band) {
    elements.years = { type: "Section", props: { title: "Years", note: "Company years, by quarter" }, children: ["band"] };
    elements.band = leaf("YearBand", { from: band[0], to: band[1], labels: "relative" });
    top.push("years");
  }
  elements.weeks = { type: "Section", props: { title: "52 weeks", note: "Where two-week blocks fit" }, children: strips.map((y) => `strip-${y}`) };
  for (const y of strips) elements[`strip-${y}`] = leaf("WeekStrip", { year: y, label: `Year ${y - 2025}` });
  top.push("weeks");
  elements.root = { type: "Stack", props: { direction: "column", gap: "lg" }, children: top };
  return { root: "root", elements };
}

// Sample personas keep their scripts; anyone else gets the script that fits their learned time scales.
const SAMPLES = ["mina", "jordan", "sam"];
function script(p: Persona): string | null {
  if (SAMPLES.includes(p.id)) return p.id;
  if (p.profile.signals.rotation) return "rotation";
  if (p.profile.signals.overnight !== undefined) return "nights";
  const scales = (p.profile.signals.timeScales as string[] | undefined) ?? [];
  if (scales.includes("year")) return scales.includes("week") ? "sam" : "mina";
  if (scales.includes("week") || scales.includes("day") || p.profile.signals.weekendEvents === false) return "jordan";
  return null;
}

// The reason cites the learned habits that match, with their numbers (P9).
function cite(p: Persona, re: RegExp, fallback: string): string {
  const facts = p.profile.facts.map((f) => f.replace(/ \(confidence [\d.]+\)$/, "")).filter((f) => re.test(f)).sort((a, b) => Number(/\d/.test(b)) - Number(/\d/.test(a)));
  if (facts.length) return `${facts.slice(0, 2).join(". ")}.`;
  // The scripted fallbacks describe the sample personas; anyone else gets their own top habits.
  if (SAMPLES.includes(p.id)) return fallback;
  const own = p.profile.facts.map((f) => f.replace(/ \(confidence [\d.]+\)$/, "")).filter((f) => /\d/.test(f) && !/^Adds events/.test(f));
  return `${own.slice(0, 2).join(". ")}.`;
}

function habitDraft(p: Persona, req: DesignRequest, n: number, round: number, who = script(p)): unknown {
  const types = Object.values(req.currentSpec.elements).map((e) => e.type);
  const week = Object.values(req.currentSpec.elements).find((e) => e.type === "WeekGrid");
  const fix = round > 0;
  const say = (title: string, reason: string, spec: CalendarSpec) => ({ proposal: { title, reason, spec } });

  if (!who) return { proposal: null, why: "Not enough learned habits yet." };

  if (who === "nights" || who === "rotation") {
    const weekOf = (w: string) => leaf("WeekGrid", { weekOf: w, days: ALL, startHour: 0, endHour: 24 });
    if (who === "nights" || types.filter((t) => t === "WeekGrid").length >= 2) {
      if (week && week.props.startHour === 0 && week.props.endHour === 24) return { proposal: null, why: `Whole days already fit ${p.name}'s nights.` };
      return say("Show whole days, midnight to midnight?", `${cite(p, /midnight/i, "")} A full-day grid draws each night as one block instead of cutting it off.`, one(weekOf(WEEK)));
    }
    const next = addDays(WEEK, 7);
    const spec: CalendarSpec = { root: "root", elements: { root: { type: "Stack", props: { direction: "column", gap: "md" }, children: ["this", "next"] }, this: weekOf(WEEK), next: weekOf(next) } };
    return say("Show this week and next together?", `${cite(p, /different weekdays/i, "")} Two weeks side by side show the whole rotation.`, spec);
  }

  if (who === "mina") {
    if (types.includes("YearBand")) return { proposal: null, why: `The years view already matches how ${p.name} plans.` };
    const reason = `${cite(p, /year|month|span/i, "Your plans run from 2026 to 2030 and the median one lasts 14 months, but you haven't opened a week or day in 3 weeks.")} A years view shows all of them at once.`;
    if (n === 1 && !fix) return say("Show this year as weeks?", reason, one(leaf("WeekStrip", { year: 2026, label: null })));
    if (n === 2 && !fix) return say("Show your plans by year?", reason, one(leaf("YearBand", { from: 2026, to: 2028, labels: "calendar" })));
    return say("Show your plans by year?", reason, one(leaf("YearBand", { from: 2026, to: 2030, labels: "calendar" })));
  }

  if (who === "jordan") {
    const days = (week?.props.days as string[] | undefined) ?? [];
    const work = String(p.profile.signals.workHours ?? "9-17").split("-").map(Number);
    if (!week) {
      const reason = cite(p, /week view|meetings/i, "You chose the week view on 9 of your last 10 visits, and nearly all your events are 30 to 90 minute meetings.");
      const hours = n === 1 && !fix ? [work[0] + 1, work[1]] : work;
      const grid = leaf("WeekGrid", { weekOf: WEEK, days: ALL, startHour: hours[0], endHour: hours[1] });
      // A repair keeps longer plans in view by putting the month under the week.
      if (fix && !SAMPLES.includes(p.id))
        return say("Show this week by the hour, with the month below?", `${reason} The month underneath keeps your longer plans in view.`, { root: "root", elements: { root: { type: "Stack", props: { direction: "column", gap: "lg" }, children: ["week", "month"] }, week: grid, month: leaf("MonthGrid", { month: TODAY.slice(0, 7) }) } });
      return say("Make the week your default view?", reason, one(grid));
    }
    if (days.length > 5 && p.profile.signals.weekendEvents !== true) {
      const reason = `${cite(p, /weekend/i, "You haven't scheduled anything on a Saturday or Sunday in 14 weeks.")} If something does land on a weekend, it will still show up.`;
      const hours = n === 1 && !fix ? [work[0], work[1] - 1] : work;
      return say("Hide weekends?", reason, one(leaf("WeekGrid", { weekOf: WEEK, days: WORK, startHour: hours[0], endHour: hours[1] })));
    }
    return { proposal: null, why: `The work week view already matches ${p.name}'s habits.` };
  }

  if (types.includes("WeekStrip")) return { proposal: null, why: `The years and weeks view already fits how ${p.name} plans.` };
  const reason = "You plan in startup years (\"year 2 to year 4\") and in weeks (\"two weeks in May\"). No standard view shows both, so this one stacks years over 52-week strips.";
  if (n === 1 && !fix) return say("Try a view designed for you?", reason, hybrid([2027, 2028], null));
  if (n === 2 && !fix) return say("Try a view designed for you?", reason, hybrid([2026, 2027, 2028], [2027, 2029]));
  return say("Try a view designed for you?", reason, hybrid([2026, 2027, 2028], [2026, 2030]));
}

// Plain month grids: this month plus the month each must-show plan starts in, so nothing is hidden.
function classicDraft(p: Persona, req: DesignRequest): unknown {
  const months = [TODAY.slice(0, 7)];
  const shown = (e: { start: string; end: string }) => months.some((m) => e.start.slice(0, 7) <= m && e.end.slice(0, 7) >= m);
  for (const e of [...mustShow(p.events)].sort((a, b) => a.start.localeCompare(b.start))) if (!shown(e)) months.push(e.start.slice(0, 7));
  const spec: CalendarSpec = months.length === 1
    ? one(leaf("MonthGrid", { month: months[0] }))
    : { root: "root", elements: { root: { type: "Stack", props: { direction: "column", gap: "lg" }, children: months.map((m) => `m-${m}`) }, ...Object.fromEntries(months.map((m) => [`m-${m}`, leaf("MonthGrid", { month: m })])) } };
  if (JSON.stringify(spec) === JSON.stringify(req.currentSpec)) return { proposal: null, why: "The plain month view already shows everything." };
  const reason = `You undid invented views, so this sticks to plain month grids: this month plus the ${months.length - 1} month${months.length === 2 ? "" : "s"} where your longer plans start.`;
  return { proposal: { title: "Show the months your plans fall in?", reason, spec } };
}

// The mock reads the learned section the way the model would: low novelty appetite means classic views only.
export function mockDraft(p: Persona, req: DesignRequest, n: number, round: number, system = ""): unknown {
  // Like the model, don't repeat a view the person turned down: try the next script that fits instead.
  const declined = new Set(req.history.filter((h) => h.status === "dismissed" || h.status === "undone").map((h) => h.title));
  const first = script(p);
  type Out = { proposal?: { title: string; spec: CalendarSpec } | null };
  let draft = habitDraft(p, req, n, round, first) as Out;
  for (const who of ["sam", "mina", "jordan"].filter((w) => first && w !== first)) {
    if (!draft.proposal || !declined.has(draft.proposal.title)) break;
    draft = habitDraft(p, req, n, round, who) as Out;
  }
  return draft.proposal && isNovel(draft.proposal.spec) && /novelty appetite: low/i.test(system) ? classicDraft(p, req) : draft;
}
