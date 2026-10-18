import { describe, expect, it } from "vitest";
import { applyOps, overlaps } from "./ops";
import type { CalEvent } from "./types";

const ev = (id: string, start: string, end = start, title = id): CalEvent => ({ id, title, start, end, category: "Personal" });

describe("applyOps", () => {
  const base = [ev("a", "2026-10-20"), ev("b", "2026-10-21")];
  let n = 0;
  const newId = () => `n${n++}`;

  it("creates, updates and deletes, and the inverse undoes it exactly", () => {
    const { events, inverse } = applyOps(base, [
      { op: "create", event: { title: "New", start: "2026-10-22", end: "2026-10-22", category: "Social" } },
      { op: "update", id: "a", before: base[0], after: { ...base[0], title: "Moved", start: "2026-10-23", end: "2026-10-23" } },
      { op: "delete", id: "b", before: base[1] },
    ], newId);
    expect(events.map((e) => e.title)).toEqual(["Moved", "New"]);
    expect(events[1].id).toMatch(/^n\d+$/);
    expect(inverse.map((o) => o.op)).toEqual(["create", "update", "delete"]);
    const undone = applyOps(events, inverse, newId).events;
    expect([...undone].sort((x, y) => x.id.localeCompare(y.id))).toEqual(base);
  });

  it("keeps a given id and skips operations on missing events", () => {
    const { events, inverse } = applyOps(base, [
      { op: "create", event: { id: "fixed", title: "X", start: "2026-10-22", end: "2026-10-22", category: "Social" } },
      { op: "update", id: "gone", before: base[0], after: base[0] },
      { op: "delete", id: "gone", before: base[0] },
    ], newId);
    expect(events.map((e) => e.id)).toEqual(["a", "b", "fixed"]);
    expect(inverse).toHaveLength(1);
  });
});

describe("overlaps", () => {
  it("compares by day, inclusive at both ends", () => {
    expect(overlaps(ev("x", "2026-10-20T09:00", "2026-10-20T10:00"), "2026-10-20", "2026-10-20")).toBe(true);
    expect(overlaps(ev("x", "2026-10-18", "2026-10-25"), "2026-10-20", "2026-10-21")).toBe(true);
    expect(overlaps(ev("x", "2026-10-18"), "2026-10-19", "2026-10-21")).toBe(false);
    expect(overlaps(ev("x", "2026-10-22"), "2026-10-19", "2026-10-21")).toBe(false);
  });
});
