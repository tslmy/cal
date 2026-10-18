import { describe, expect, it } from "vitest";
import { isNovel, type CalendarSpec } from "./catalog";
import { critique, focusWeek, mustShow, rangeOf, sameShape, sharedPeriods } from "./critic";
import type { CalEvent } from "./types";

type El = CalendarSpec["elements"][string];
const leaf = (type: string, props: Record<string, unknown>): El => ({ type, props, children: [] });
const one = (el: El): CalendarSpec => ({ root: "view", elements: { view: el } });
const ev = (title: string, start: string, end = start): CalEvent => ({ id: title, title, start, end, category: "Personal" });

const month = one(leaf("MonthGrid", { month: "2026-10" }));
// TODAY is Saturday 2026-10-17, so views are asked to show the week starting Monday 2026-10-19.
const nextWeek = (startHour = 8, endHour = 18) => one(leaf("WeekGrid", { weekOf: "2026-10-19", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], startHour, endHour }));

describe("rangeOf", () => {
  it("gives the dates each view covers", () => {
    expect(rangeOf(leaf("MonthGrid", { month: "2026-12" }))).toEqual(["2026-12-01", "2026-12-31"]);
    expect(rangeOf(leaf("WeekGrid", { weekOf: "2026-10-21" }))).toEqual(["2026-10-19", "2026-10-25"]);
    expect(rangeOf(leaf("NightGrid", { weekOf: "2026-10-19" }))).toEqual(["2026-10-19", "2026-10-26"]);
    expect(rangeOf(leaf("WeekStrip", { year: 2026 }))).toEqual(["2025-12-29", "2027-01-03"]);
    expect(rangeOf(leaf("YearBand", { from: 2026, to: 2030 }))).toEqual(["2026-01-01", "2030-12-31"]);
    expect(rangeOf(leaf("Stack", {}))).toBeNull();
  });

  it("throws for props that name no real date", () => {
    expect(() => rangeOf(leaf("MonthGrid", { month: "2026-13" }))).toThrow();
    expect(() => rangeOf(leaf("WeekGrid", { weekOf: "this week" }))).toThrow();
    expect(() => rangeOf(leaf("YearBand", { from: 2030, to: 2026 }))).toThrow();
    expect(() => rangeOf(leaf("YearBand", { from: 2026, to: 2040 }))).toThrow();
  });
});

describe("mustShow", () => {
  it("keeps the coming week and long plans still ahead", () => {
    expect(focusWeek()).toBe("2026-10-19");
    const events = [ev("Dentist", "2026-10-20"), ev("Old", "2026-10-01"), ev("Later", "2026-12-01"), ev("Sabbatical", "2027-01-01", "2027-06-30"), ev("Past trip", "2026-01-01", "2026-02-01")];
    expect(mustShow(events).map((e) => e.title)).toEqual(["Dentist", "Sabbatical"]);
  });
});

describe("critique", () => {
  it("passes a plain month and tidies near misses", () => {
    const sloppy = { root: "s", elements: { s: { type: "Stack", props: { direction: "column" }, children: ["w"] }, w: { type: "WeekGrid", props: { weekOf: "2026-10-19", days: ["Mon", "tuesday"], startHour: 8, endHour: 18 } } } };
    const out = critique(sloppy, []);
    expect(out.ok).toBe(true);
    expect(out.spec!.elements.s.props.gap).toBeNull();
    expect(out.spec!.elements.w.props.days).toEqual(["mon", "tue"]);
    expect(critique(month, []).ok).toBe(true);
  });

  it("rejects specs off the catalog or with impossible dates", () => {
    expect(critique({ root: "v", elements: { v: { type: "Agenda", props: {} } } }, []).issues[0]).toMatch(/catalog/);
    expect(critique(one(leaf("MonthGrid", { month: "October" })), []).issues[0]).toMatch(/real date/);
  });

  it("reports broken trees", () => {
    const missing = { root: "s", elements: { s: { type: "Stack", props: { direction: "row", gap: null }, children: ["nope"] }, m: leaf("MonthGrid", { month: "2026-10" }) } };
    expect(critique(missing, []).issues).toContain('Child "nope" is referenced but not defined.');
    const twice = { root: "s", elements: { s: { type: "Stack", props: { direction: "row", gap: null }, children: ["m", "m"] }, m: leaf("MonthGrid", { month: "2026-10" }) } };
    expect(critique(twice, []).issues).toContain('Element "m" appears twice in the tree.');
    expect(critique({ ...month, root: "other" }, []).issues[0]).toMatch(/Root "other"/);
    expect(critique(one({ type: "Section", props: { title: null, note: null }, children: [] }), []).issues[0]).toMatch(/No calendar view/);
  });

  it("asks for events it must show and hours that fit them", () => {
    const events = [ev("Sabbatical", "2027-01-01", "2027-06-30"), { ...ev("Late call", "2026-10-20T19:00", "2026-10-20T20:00") }];
    const out = critique(nextWeek(), events);
    expect(out.ok).toBe(false);
    expect(out.issues.some((i) => i.includes('"Sabbatical"'))).toBe(true);
    expect(out.issues.some((i) => i.includes("cut off 1 event"))).toBe(true);
    expect(critique(nextWeek(10, 9), []).issues).toContain("WeekGrid endHour must be after startHour.");
  });

  it("wants today or the coming week in view, and something new", () => {
    expect(critique(one(leaf("MonthGrid", { month: "2027-03" })), []).issues[0]).toMatch(/No view includes today/);
    expect(critique(month, [], month).issues).toContain("The proposal is the same as the current view.");
  });
});

describe("shape helpers", () => {
  it("compares specs by content, not keys", () => {
    const renamed: CalendarSpec = { root: "x", elements: { x: leaf("MonthGrid", { month: "2026-10" }) } };
    expect(sameShape(month, renamed)).toBe(true);
    expect(sameShape(month, nextWeek())).toBe(false);
  });

  it("counts the weeks two views share", () => {
    expect(sharedPeriods(month, nextWeek())).toBe(1);
    expect(sharedPeriods(month, one(leaf("YearBand", { from: 2027, to: 2028, labels: "calendar" })))).toBe(0);
    expect(sharedPeriods(month, one(leaf("MonthGrid", { month: "bad" })))).toBe(0);
  });

  it("calls anything beyond month and week grids novel", () => {
    expect(isNovel(month)).toBe(false);
    expect(isNovel(one(leaf("WeekStrip", { year: 2026, label: null })))).toBe(true);
  });
});
