import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dedupe, parseEmail, parseIcs } from "./importer";
import type { UserState } from "../../src/shared/types";

const sample = (name: string) => readFileSync(new URL(`../../samples/${name}`, import.meta.url), "utf8");
const stateWith = (events: UserState["events"]) => ({ events }) as UserState;

const ics = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;

describe("parseIcs", () => {
  it("reads the sample calendar and expands its weekly sync", () => {
    const out = parseIcs(sample("team-offsite.ics"));
    expect(out.calendar).toBe("Platform Team");
    expect(out.recurring).toBeGreaterThan(0);
    const sync = out.drafts.filter((d) => d.title === "Platform team sync");
    expect(sync.length).toBeGreaterThan(1);
    expect(sync.every((d) => d.recurrence?.includes("FREQ=WEEKLY"))).toBe(true);
    expect(out.drafts.find((d) => d.title === "Team offsite, Lake Tahoe")).toBeDefined();
  });

  it("converts UTC times to the home zone and keeps floating times", () => {
    const { drafts } = parseIcs(ics([
      "BEGIN:VEVENT", "UID:u1", "SUMMARY:Call", "DTSTART:20261020T170000Z", "DTEND:20261020T180000Z", "END:VEVENT",
      "BEGIN:VEVENT", "UID:u2", "SUMMARY:Floating", "DTSTART:20261021T090000", "DTEND:20261021T100000", "END:VEVENT",
      "BEGIN:VEVENT", "UID:u3", "SUMMARY:Holiday", "DTSTART;VALUE=DATE:20261026", "DTEND;VALUE=DATE:20261027", "END:VEVENT",
    ].join("\r\n")));
    const by = Object.fromEntries(drafts.map((d) => [d.title, d]));
    expect(by.Call).toMatchObject({ start: "2026-10-20T10:00", end: "2026-10-20T11:00", uid: "u1#2026-10-20T10:00", source: "ics" });
    expect(by.Floating).toMatchObject({ start: "2026-10-21T09:00", end: "2026-10-21T10:00" });
    expect(by.Holiday).toMatchObject({ start: "2026-10-26", end: "2026-10-26" });
  });

  it("uses a TZID even without a VTIMEZONE block", () => {
    const { drafts } = parseIcs(ics(["BEGIN:VEVENT", "UID:ny", "SUMMARY:NY", "DTSTART;TZID=America/New_York:20261020T130000", "DTEND;TZID=America/New_York:20261020T140000", "END:VEVENT"].join("\r\n")));
    expect(drafts[0]).toMatchObject({ start: "2026-10-20T10:00", end: "2026-10-20T11:00" });
  });
});

describe("dedupe", () => {
  it("drops events already there and repeats within the batch", () => {
    const state = stateWith([{ id: "a", title: "Sync", start: "2026-10-20T10:00", end: "2026-10-20T11:00", category: "Meetings", uid: "u1" }]);
    const d = (title: string, start: string, uid?: string) => ({ title, start, end: start, category: "x", uid });
    const out = dedupe([d("Anything", "2026-10-21", "u1"), d("sync", "2026-10-20T10:00"), d("New", "2026-10-22", "n"), d("New again", "2026-10-23", "n"), d("New", "2026-10-22")], state);
    expect(out.fresh.map((x) => x.title)).toEqual(["New"]);
    expect(out.dupes).toBe(4);
  });
});

describe("parseEmail", () => {
  it("reads a booking offline as a stay from check-in to check-out", async () => {
    const out = await parseEmail("booking.eml", sample("booking-confirmation.eml"), stateWith([]));
    expect(out.via).toBe("heuristic");
    expect(out.drafts).toEqual([expect.objectContaining({ title: "Stay: Granlibakken Tahoe", start: "2026-11-04", end: "2026-11-07", category: "Travel", source: "email" })]);
  });

  it("prefers an attached invite", async () => {
    const raw = [
      "Subject: Invitation: Planning", "Message-ID: <m1@x>", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b"', "",
      "--b", "Content-Type: text/plain", "", "See invite.", "--b", "Content-Type: text/calendar; method=REQUEST", "",
      ics(["BEGIN:VEVENT", "UID:inv", "SUMMARY:Planning", "DTSTART:20261022T160000Z", "DTEND:20261022T170000Z", "END:VEVENT"].join("\r\n")), "--b--", "",
    ].join("\r\n");
    const out = await parseEmail("invite.eml", raw, stateWith([]));
    expect(out.via).toBe("ics");
    expect(out.drafts).toEqual([expect.objectContaining({ title: "Planning", start: "2026-10-22T09:00", source: "email" })]);
  });

  it("names a restaurant booking by meal and place", async () => {
    const raw = ["Subject: Reservation confirmed", "Date: Fri, 16 Oct 2026 10:00:00 -0700", "", "Your table for 2 at Nopa is booked for October 23, 2026 at 7:30 PM."].join("\r\n");
    const out = await parseEmail("dinner.eml", raw, stateWith([]));
    expect(out.drafts[0]).toMatchObject({ title: "Dinner at Nopa", start: "2026-10-23T19:30", end: "2026-10-23T20:30" });
  });

  it("finds nothing in a newsletter", async () => {
    const out = await parseEmail("news.eml", "Subject: Our autumn newsletter\r\n\r\nTen tips for fall.", stateWith([]));
    expect(out.drafts).toEqual([]);
  });
});
