import { describe, expect, it } from "vitest";
import { parseIntent, parseOffline, resolve } from "./intent";
import type { CalEvent, UserState } from "../../src/shared/types";

// TODAY is Saturday 2026-10-17; the offline parser is what runs with no model key.
const ev = (id: string, title: string, start: string, end = start, category = "Personal"): CalEvent => ({ id, title, start, end, category });
const stateWith = (events: CalEvent[]): UserState => ({
  id: "t", name: "T", role: "", events, interactions: [], beliefs: [], prompts: [], activity: [], proposals: [], undo: [],
  settings: { threshold: 0.7, minGapMinutes: 0, proposalsOn: true }, spec: { root: "v", elements: {} },
} as unknown as UserState);

describe("parseOffline", () => {
  it("reads an exact and an approximate time", () => {
    expect(parseOffline("dentist tomorrow 10am", "typed")).toEqual([
      { op: "create", title: "Dentist", start: "2026-10-18T10:00", end: "2026-10-18T11:00", category: "Health", precision: "exact", repeat: null },
    ]);
    const [lunch] = parseOffline("lunch with Ana Thursday around noon", "typed");
    expect(lunch).toMatchObject({ op: "create", title: "Lunch with Ana", start: "2026-10-22T12:00", precision: "approximate", category: "Social" });
  });

  it("keeps vague spans vague", () => {
    expect(parseOffline("visit grandma sometime next week", "typed")[0]).toMatchObject({ start: "2026-10-19", end: "2026-10-25", precision: "week" });
    expect(parseOffline("ski trip sometime in January", "typed")[0]).toMatchObject({ start: "2027-01-01", end: "2027-01-31", precision: "span", category: "Travel" });
    expect(parseOffline("raise money from year 2 to year 3", "typed")[0]).toMatchObject({ start: "2027-01-01", end: "2028-12-31", precision: "span" });
  });

  it("turns 'every' into a repeat", () => {
    expect(parseOffline("yoga every Tue and Thu at 7am", "typed")[0]).toMatchObject({ op: "create", title: "Yoga", repeat: { days: ["tue", "thu"], until: null } });
  });

  it("reads deletes, moves and questions", () => {
    expect(parseOffline("empty out my weekend for a business trip", "typed")).toEqual([
      { op: "delete", filter: { from: "2026-10-17", to: "2026-10-18", titleContains: null, which: "all" } },
      { op: "create", title: "Business trip", start: "2026-10-17", end: "2026-10-18", category: "Travel", precision: "span" },
    ]);
    expect(parseOffline("move my dentist to next week", "typed")[0]).toMatchObject({ op: "update", shiftDays: 7, filter: { titleContains: "dentist", which: "next" } });
    expect(parseOffline("push the design review back a day", "typed")[0]).toMatchObject({ op: "update", shiftDays: 1 });
    expect(parseOffline("what's on Friday?", "typed")[0]).toMatchObject({ op: "query", filter: { from: "2026-10-23", to: "2026-10-23" } });
    // Questions inside a pasted note are remarks, not queries.
    expect(parseOffline("Fine.\nWhat's on Friday?", "text")).toEqual([]);
  });

  it("splits a pasted note into steps", () => {
    const ops = parseOffline("Cancel standup on Monday.\nDinner with Ana on Wednesday around 7pm.", "text").map((s) => s.op);
    expect(ops).toEqual(["delete", "create"]);
  });
});

describe("resolve", () => {
  const events = [
    ev("d", "Dentist", "2026-10-20T10:00", "2026-10-20T11:00", "Health"),
    ev("s1", "Standup", "2026-10-19T09:30", "2026-10-19T10:00", "Meetings"),
    ev("s2", "Standup", "2026-10-20T09:30", "2026-10-20T10:00", "Meetings"),
    ev("hike", "Hike", "2026-10-17"),
    ev("long", "Sabbatical", "2026-10-01", "2026-12-31"),
  ];
  const state = stateWith(events);

  it("resolves filters to concrete events", () => {
    const cs = resolve(state, parseOffline("move my dentist to next week", "typed"), "typed");
    expect(cs.ops).toEqual([{ op: "update", id: "d", before: events[0], after: { ...events[0], start: "2026-10-27T10:00", end: "2026-10-27T11:00" } }]);
    expect(cs.summary).toMatch(/Dentist/);
  });

  it("clears a weekend but leaves long plans that span it", () => {
    const cs = resolve(state, parseOffline("empty out my weekend for a business trip", "typed"), "typed");
    expect(cs.ops.map((o) => o.op)).toEqual(["delete", "create"]);
    expect(cs.ops[0]).toMatchObject({ id: "hike" });
  });

  it("moves to a time of day, keeping the date and length", () => {
    const cs = resolve(state, [{ op: "update", filter: { from: "2026-10-20", to: "2026-10-20", titleContains: "dentist" }, timeOfDay: "14:00" }], "typed");
    expect(cs.ops[0]).toMatchObject({ after: { start: "2026-10-20T14:00", end: "2026-10-20T15:00" } });
  });

  it("answers questions and skips events already there", () => {
    const q = resolve(state, parseOffline("what's on Tuesday?", "typed"), "typed");
    expect(q.ops).toEqual([]);
    expect(q.answer).toMatch(/Dentist/);
    const dup = resolve(state, parseOffline("dentist Tuesday 10am", "typed"), "typed");
    expect(dup.ops).toEqual([]);
    expect(dup.answer).toMatch(/already/);
  });

  it("expands repeats and lets a later line edit an earlier one", () => {
    const cs = resolve(stateWith([]), [
      { op: "create", title: "Walk", start: "2026-10-19T07:00", end: "2026-10-19T08:00", category: "Personal", precision: "exact", repeat: { days: ["mon"], until: "2026-11-02" } },
      { op: "delete", filter: { from: "2026-10-26", to: "2026-10-26", titleContains: "walk" } },
    ], "text");
    expect(cs.ops.map((o) => o.op === "create" && o.event.start)).toEqual(["2026-10-19T07:00", "2026-11-02T07:00"]);
  });

  it("says when nothing matched", () => {
    expect(resolve(state, parseOffline("cancel the board meeting", "typed"), "typed").answer).toBe("No matching events found.");
    expect(resolve(state, [], "typed").answer).toMatch(/couldn't find anything/);
  });
});

describe("parseIntent", () => {
  it("runs the offline parser and traces it", async () => {
    const out = await parseIntent(stateWith([]), "coffee with Lee around 3pm Monday", "typed");
    expect(out.query).toBe(false);
    expect(out.changeSet.ops[0]).toMatchObject({ op: "create", event: { title: "Coffee with Lee", start: "2026-10-19T15:00", precision: "approximate" } });
    expect(out.trace.at(-1)!.text).toMatch(/offline parser/);
  });
});
