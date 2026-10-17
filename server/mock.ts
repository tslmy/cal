import type { CalendarSpec } from "../src/shared/catalog";
import type { DesignRequest, Persona } from "../src/shared/types";
import { mondayOf, TODAY } from "../src/shared/dates";
import { mustShow } from "../src/shared/critic";

// Offline stand-in for the model, used when no CRUSOE_API_KEY is set.
// Some first drafts are deliberately flawed so the critic and repair loop have something to catch.

type El = CalendarSpec["elements"][string];
const leaf = (type: string, props: Record<string, unknown>): El => ({ type, props, children: [] });
const one = (el: El): CalendarSpec => ({ root: "view", elements: { view: el } });

const WEEK = mondayOf(TODAY);
const ALL = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WORK = ["mon", "tue", "wed", "thu", "fri"];

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
function script(p: Persona): string | null {
  if (["mina", "jordan", "sam"].includes(p.id)) return p.id;
  const scales = (p.profile.signals.timeScales as string[] | undefined) ?? [];
  if (scales.includes("year")) return scales.includes("week") ? "sam" : "mina";
  if (scales.includes("week") || scales.includes("day") || p.profile.signals.weekendEvents === false) return "jordan";
  return null;
}

// The reason cites the learned habits that match, with their numbers (P9).
function cite(p: Persona, re: RegExp, fallback: string): string {
  const facts = p.profile.facts.map((f) => f.replace(/ \(confidence [\d.]+\)$/, "")).filter((f) => re.test(f)).sort((a, b) => Number(/\d/.test(b)) - Number(/\d/.test(a)));
  return facts.length ? `${facts.slice(0, 2).join(". ")}.` : fallback;
}

function habitDraft(p: Persona, req: DesignRequest, n: number, round: number, who = script(p)): unknown {
  const types = Object.values(req.currentSpec.elements).map((e) => e.type);
  const week = Object.values(req.currentSpec.elements).find((e) => e.type === "WeekGrid");
  const fix = round > 0;
  const say = (title: string, reason: string, spec: CalendarSpec) => ({ proposal: { title, reason, spec } });

  if (!who) return { proposal: null, why: "Not enough learned habits yet." };

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
      return say("Make the week your default view?", reason, one(leaf("WeekGrid", { weekOf: WEEK, days: ALL, startHour: hours[0], endHour: hours[1] })));
    }
    if (days.length > 5) {
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

const CLASSIC = ["MonthGrid", "WeekGrid", "Stack", "Section"];
const novel = (spec: CalendarSpec) => Object.values(spec.elements).some((e) => !CLASSIC.includes(e.type));

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
  return draft.proposal && novel(draft.proposal.spec) && /novelty appetite: low/i.test(system) ? classicDraft(p, req) : draft;
}
