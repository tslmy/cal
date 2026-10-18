import { beforeEach, describe, expect, it } from "vitest";
import { candidates, learn } from "./habit";
import { getUser, log, resetUser, update } from "../store";
import { PERSONAS } from "../../src/shared/personas";
import type { UserState } from "../../src/shared/types";

const persona = (id: string) => PERSONAS.find((p) => p.id === id)!;
const stateOf = (id: string): UserState => ({ ...getUser(id)!, events: persona(id).events, interactions: [] });
const byKey = (s: UserState) => Object.fromEntries(candidates(s).map((c) => [c.key, c]));

describe("candidates", () => {
  it("sees an office worker's weekdays and meetings", () => {
    const c = byKey(stateOf("jordan"));
    expect(c.weekendEvents.value).toBe(false);
    expect(c.weekendEvents.statement).toMatch(/^No weekend events in \d+ weeks$/);
    expect(c.meetingsPerWeek.statement).toMatch(/mostly 30 to 90 minutes/);
    expect(c.workHours.value).toBe("9-17");
    expect(c.timeScales.value).toEqual(["day", "week"]);
  });

  it("sees a long-range planner's years", () => {
    const c = byKey(stateOf("mina"));
    expect(c.timeScales.value).toContain("year");
    expect(c.horizonYears.value).toBeGreaterThanOrEqual(4);
  });

  it("needs a few events before saying anything", () => {
    expect(candidates({ ...stateOf("jordan"), events: [] })).toEqual([]);
  });

  it("learns the preferred view and how events arrive", () => {
    const week = { to: { elements: { v: { type: "WeekGrid" } } } };
    const interactions = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `v${i}`, at: "", kind: "view_switch" as const, source: "manual" as const, payload: week })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, at: "", kind: "create" as const, source: "typed" as const, payload: {} })),
    ];
    const c = byKey({ ...stateOf("jordan"), interactions });
    expect(c.preferredView).toMatchObject({ value: "week", statement: "Chose the week view 4 of the last 4 visits" });
    expect(c.sources).toMatchObject({ value: ["typed"], statement: "Adds events mostly by typing (3 of 3)" });
  });
});

describe("learn", () => {
  beforeEach(() => resetUser("you", true));

  it("does nothing for a person with no history", async () => {
    expect(await learn("you")).toEqual({ changes: [], crossings: [] });
    expect(getUser("you")!.learnedThrough).toBe(0);
  });

  it("turns events into beliefs and logs crossings", async () => {
    await update("you", (s) => void (s.events = persona("jordan").events.map((e) => ({ ...e }))));
    for (let i = 0; i < 6; i++) await log("you", "create", {}, "typed");
    const out = await learn("you", "Week 1");
    expect(out.changes.length).toBeGreaterThan(0);
    const s = getUser("you")!;
    expect(s.beliefs.map((b) => b.key)).toContain("weekendEvents");
    expect(s.learnedThrough).toBe(6);
    expect(s.activity.some((a) => a.text.startsWith("Week 1: Updated"))).toBe(true);
    // A second pass over the same log does not move anything past the threshold again.
    expect((await learn("you")).crossings).toEqual([]);
  });

  it("refuses an unknown person", async () => {
    await expect(learn("nobody")).rejects.toThrow("no such user");
  });
});
