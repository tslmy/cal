import { describe, expect, it } from "vitest";
import { fmtDate, fmtWhen, plural } from "./when";

describe("when", () => {
  it("pluralizes", () => {
    expect(plural(1, "event")).toBe("1 event");
    expect(plural(0, "event")).toBe("0 events");
    expect(plural(3, "week")).toBe("3 weeks");
  });

  it("drops the year only for this year", () => {
    expect(fmtDate("2026-10-17")).toBe("Sat Oct 17");
    expect(fmtDate("2027-01-04")).toBe("Mon Jan 4 2027");
  });

  it("words each kind of precision", () => {
    expect(fmtWhen({ start: "2026-10-20", end: "2026-10-20", precision: "day" })).toBe("Tue Oct 20");
    expect(fmtWhen({ start: "2026-10-19", end: "2026-10-25", precision: "week" })).toBe("Sometime Mon Oct 19 to Sun Oct 25");
    expect(fmtWhen({ start: "2026-10-24", end: "2026-10-25", precision: "span" })).toBe("Sat Oct 24 to Sun Oct 25");
    expect(fmtWhen({ start: "2026-10-22T12:00", end: "2026-10-22T13:00", precision: "approximate" })).toBe("Thu Oct 22, around 12:00");
    expect(fmtWhen({ start: "2026-10-22T09:00", end: "2026-10-22T10:30", precision: "exact" })).toBe("Thu Oct 22, 09:00 to 10:30");
    expect(fmtWhen({ start: "2026-10-19T19:00", end: "2026-10-20T07:00" })).toBe("Mon Oct 19, 19:00 to Tue Oct 20 07:00");
  });
});
