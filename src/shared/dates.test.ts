import { describe, expect, it } from "vitest";
import { addDays, dayId, daysBetween, endHourOf, fmtDay, hourOf, isoWeek, mondayOf, mondayOfIsoWeek, monthId, parseDay, weekday, weekId, weeksInIsoYear } from "./dates";

describe("dates", () => {
  it("parses and formats days in UTC", () => {
    expect(fmtDay(parseDay("2026-10-17"))).toBe("2026-10-17");
    expect(fmtDay(parseDay("2026-10-17T09:30"))).toBe("2026-10-17");
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-10-17", "2026-10-24")).toBe(7);
    expect(daysBetween("2026-10-24", "2026-10-17")).toBe(-7);
  });

  it("numbers weekdays from Monday", () => {
    expect(weekday("2026-10-19")).toBe(0); // Monday
    expect(weekday("2026-10-17")).toBe(5); // Saturday
    expect(weekday("2026-10-18")).toBe(6); // Sunday
    expect(mondayOf("2026-10-18")).toBe("2026-10-12");
    expect(mondayOf("2026-10-12")).toBe("2026-10-12");
  });

  it("follows ISO week rules at year boundaries", () => {
    expect(isoWeek("2026-10-17")).toEqual({ year: 2026, week: 42 });
    expect(isoWeek("2027-01-01")).toEqual({ year: 2026, week: 53 });
    expect(isoWeek("2024-12-30")).toEqual({ year: 2025, week: 1 });
    expect(weeksInIsoYear(2026)).toBe(53);
    expect(weeksInIsoYear(2025)).toBe(52);
    expect(mondayOfIsoWeek(2026, 1)).toBe("2025-12-29");
    expect(mondayOfIsoWeek(2026, 42)).toBe("2026-10-12");
  });

  it("reads hours and builds ids", () => {
    expect(hourOf("2026-10-17")).toBe(0);
    expect(hourOf("2026-10-17T09:30")).toBe(9.5);
    expect(endHourOf("2026-10-17T19:00", "2026-10-18T07:00")).toBe(24);
    expect(endHourOf("2026-10-17T09:00", "2026-10-17T10:15")).toBe(10.25);
    expect(weekId("2026-01-05")).toBe("week-2026-02");
    expect(monthId("2026-10-17T09:00")).toBe("month-2026-10");
    expect(dayId("2026-10-17T09:00")).toBe("day-2026-10-17");
  });
});
