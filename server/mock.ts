import type { CalendarSpec } from "../src/shared/catalog";
import type { DesignRequest, Persona } from "../src/shared/types";
import { mondayOf, TODAY } from "../src/shared/dates";

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

export function mockDraft(p: Persona, req: DesignRequest, n: number, round: number): unknown {
  const types = Object.values(req.currentSpec.elements).map((e) => e.type);
  const week = Object.values(req.currentSpec.elements).find((e) => e.type === "WeekGrid");
  const fix = round > 0;
  const say = (title: string, reason: string, spec: CalendarSpec) => ({ proposal: { title, reason, spec } });

  const who = script(p);
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
