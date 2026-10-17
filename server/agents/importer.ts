import ICAL from "ical.js";
import { simpleParser, type ParsedMail } from "mailparser";
import * as chrono from "chrono-node";
import { z } from "zod";
import { structured, isLive } from "../llm";
import { systemFor } from "../prompts";
import { TODAY, addDays } from "../../src/shared/dates";
import type { EventDraft, Source, UserState } from "../../src/shared/types";

// Turns .ics files and emails into event drafts (P4, P6, P7). The app stores wall-clock times with
// no zone, so everything is converted to one home zone; America/Los_Angeles unless EVOLVE_TZ says otherwise.
export const HOME_ZONE = process.env.EVOLVE_TZ ?? "America/Los_Angeles";

// Recurrences are expanded inside this window around TODAY.
const FROM = addDays(TODAY, -92);
const TO = addDays(TODAY, 366);
const MAX_PER_SERIES = 400;

const pad = (n: number) => String(n).padStart(2, "0");
const wallParts = (ms: number, zone: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(ms).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
const validZone = (z: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
};
// Wall time in an IANA zone to an instant: guess, measure the zone's offset there, correct twice for DST edges.
function zonedToMs(t: ICAL.Time, zone: string): number {
  const wall = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  let ms = wall;
  for (let i = 0; i < 2; i++) ms = wall - (Date.parse(`${wallParts(ms, zone)}Z`) - ms);
  return ms;
}

function toHome(t: ICAL.Time, tzid: string | undefined): string {
  if (t.isDate) return `${t.year}-${pad(t.month)}-${pad(t.day)}`;
  const zone = t.zone?.tzid;
  if (zone && zone !== "floating") return wallParts(t.toUnixTime() * 1000, HOME_ZONE); // UTC or a VTIMEZONE from the file
  if (tzid && validZone(tzid)) return wallParts(zonedToMs(t, tzid), HOME_ZONE); // TZID with no VTIMEZONE block
  return `${t.year}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}`; // floating: keep the wall clock
}

export type Parsed = { drafts: EventDraft[]; series: number; recurring: number; calendar?: string };

export function parseIcs(text: string, source: Source = "ics"): Parsed {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const tz of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(tz);
  const calendar = (root.getFirstPropertyValue("x-wr-calname") as string | null) ?? undefined;
  const events = root.getAllSubcomponents("vevent").map((c) => new ICAL.Event(c));
  // Moved or edited single occurrences (RECURRENCE-ID) attach to their series.
  const masters = new Map<string, ICAL.Event>();
  for (const e of events) if (!e.isRecurrenceException()) masters.set(e.uid, e);
  for (const e of events) if (e.isRecurrenceException()) masters.get(e.uid)?.relateException(e);

  const drafts: EventDraft[] = [];
  let recurring = 0;
  for (const ev of masters.values()) {
    const startTz = ev.component.getFirstProperty("dtstart")?.getParameter("tzid") as string | undefined;
    const endTz = (ev.component.getFirstProperty("dtend")?.getParameter("tzid") as string | undefined) ?? startTz;
    const category = (ev.component.getFirstPropertyValue("categories") as string | null) ?? calendar ?? "Imported";
    const rrule = ev.component.getFirstPropertyValue("rrule");
    const add = (start: ICAL.Time, end: ICAL.Time | null, title: string) => {
      const s = toHome(start, startTz);
      let e = end ? toHome(end, endTz) : s;
      // .ics all-day ends are exclusive; the app's are inclusive.
      if (start.isDate) e = end && e > s ? addDays(e, -1) : s;
      if (e.slice(0, 10) < FROM || s.slice(0, 10) > TO) return;
      drafts.push({ title: title || "(untitled)", start: s, end: e, category, source, uid: `${ev.uid}#${s}`, ...(rrule ? { recurrence: `RRULE:${rrule.toString()}` } : {}) });
    };
    if (!ev.isRecurring()) {
      add(ev.startDate, ev.endDate, ev.summary);
      continue;
    }
    recurring++;
    const it = ev.iterator();
    for (let n = 0, next = it.next(); next && n < MAX_PER_SERIES; next = it.next(), n++) {
      if (toHome(next, startTz).slice(0, 10) > TO) break;
      const d = ev.getOccurrenceDetails(next);
      add(d.startDate, d.endDate, d.item.summary);
    }
  }
  return { drafts, series: masters.size, recurring, calendar };
}

// ---------- email ----------

const isoDay = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const fmt = (c: chrono.ParsedComponents) =>
  c.isCertain("hour") ? `${isoDay(c.get("year")!, c.get("month")!, c.get("day")!)}T${pad(c.get("hour")!)}:${pad(c.get("minute") ?? 0)}` : isoDay(c.get("year")!, c.get("month")!, c.get("day")!);
const plusHour = (s: string) => {
  const d = new Date(`${s}:00Z`);
  d.setUTCHours(d.getUTCHours() + 1);
  return d.toISOString().slice(0, 16);
};

const KINDS: [RegExp, string, string][] = [
  [/check-?in|hotel|your stay|airbnb|lodge|resort/i, "stay", "Travel"],
  [/flight|boarding|airline|depart(ure|s)?\b|itinerary/i, "flight", "Travel"],
  [/table for|restaurant|dinner|lunch|brunch/i, "meal", "Personal"],
  [/appointment|doctor|dentist|clinic|haircut/i, "appointment", "Personal"],
  [/invit(ation|e)|meeting|webinar|call\b/i, "invite", "Meetings"],
];
const cleanSubject = (s: string) =>
  s.replace(/^((re|fwd?|fw):\s*)+/i, "").replace(/^(your\s+)?(booking|reservation|order)?\s*(confirmation|confirmed|is confirmed|invitation|reminder)\s*[:\-–]\s*/i, "")
    .replace(/,?\s*(\w{3,9}\.? \d{1,2}(\s*[-–]\s*\d{1,2})?)$/i, "").replace(/\s+(is|has been)\s+confirmed!?$/i, "").replace(/^your\s+/i, "").trim();
// "Table for 2 at Nopa" or "reservation at Nopa" names the place; the hour says which meal.
const venue = (s: string) => s.match(/\b(?:table|reservation|booking)\b[^.\n]*?\bat ([A-Z][\w'&-]*(?: [A-Z][\w'&-]*)*)/)?.[1];
const meal = (start: string) => (start.length <= 10 ? "Reservation" : +start.slice(11, 13) >= 16 ? "Dinner" : +start.slice(11, 13) >= 11 ? "Lunch" : "Breakfast");

// Offline extraction: chrono-node finds the dates, the subject names the event.
function heuristic(mail: ParsedMail, id: string): EventDraft[] {
  const subject = mail.subject ?? "";
  const body = (mail.text ?? "").replace(/\r/g, "");
  const ref = mail.date ?? new Date(`${TODAY}T12:00:00`);
  const kind = KINDS.find(([re]) => re.test(`${subject}\n${body}`));
  if (!kind) return [];
  const [, what, category] = kind;
  const title = cleanSubject(subject) || subject || "Event from email";
  const base = { category, source: "email" as const };
  if (what === "stay") {
    const inLine = body.match(/check[- ]?in[^\n]*/i)?.[0];
    const outLine = body.match(/check[- ]?out[^\n]*/i)?.[0];
    const a = inLine && chrono.parse(inLine, ref, { forwardDate: true })[0];
    const b = outLine && chrono.parse(outLine, ref, { forwardDate: true })[0];
    if (a && b) {
      const s = fmt(a.start).slice(0, 10);
      return [{ ...base, title: `Stay: ${title}`, start: s, end: fmt(b.start).slice(0, 10), uid: `${id}#${s}` }];
    }
  }
  const hit = chrono.parse(`${subject}\n${body}`, ref, { forwardDate: true }).find((r) => r.start.isCertain("day"));
  if (!hit) return [];
  const s = fmt(hit.start);
  const e = hit.end ? fmt(hit.end) : s.length > 10 ? plusHour(s) : s;
  const place = what === "meal" ? venue(`${subject}\n${body}`) : undefined;
  return [{ ...base, title: place ? `${meal(s)} at ${place}` : title, start: s, end: e < s ? s : e, uid: `${id}#${s}` }];
}

const WHEN = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/);
const Extracted = z.object({
  events: z.array(z.object({ title: z.string().min(1), start: WHEN, end: WHEN, category: z.string().min(1) })).max(10),
});
const CORE = `You extract calendar events from one email: bookings, reservations, flights, invitations, appointments, confirmations.
Reply with JSON only: {"events":[{"title","start","end","category"}]}.
- start/end: "YYYY-MM-DD" for all-day or multi-day things (a hotel stay runs check-in day to check-out day, inclusive), else "YYYY-MM-DDTHH:mm" in the event's local wall-clock time.
- If no time is given, use the all-day form. If no end is given for a timed event, end one hour after start.
- title: short, specific, like "Flight SFO to JFK" or "Dinner at Nopa". category: one word such as Travel, Meetings, Personal.
- Newsletters, receipts without a date to attend, and marketing are not events: return {"events":[]}.`;

async function llm(mail: ParsedMail, id: string, state: UserState): Promise<EventDraft[]> {
  const prompt = `Today is ${TODAY}. Email sent ${mail.date?.toISOString() ?? "unknown"}.\nFrom: ${mail.from?.text ?? ""}\nSubject: ${mail.subject ?? ""}\n\n${(mail.text ?? "").slice(0, 6000)}`;
  const out = await structured(Extracted, systemFor(CORE, state, "importer"), prompt, { role: "designer", temperature: 0 });
  return out.events.map((e) => ({ ...e, end: e.end < e.start ? e.start : e.end, source: "email" as const, uid: `${id}#${e.start}` }));
}

export type EmailResult = { name: string; subject: string; drafts: EventDraft[]; via: "ics" | "model" | "heuristic"; error?: string };

export async function parseEmail(name: string, raw: string, state: UserState): Promise<EmailResult> {
  const mail = await simpleParser(raw);
  const id = mail.messageId ?? name;
  const subject = mail.subject ?? name;
  // Invites usually carry a text/calendar part; that is exact, so it wins over guessing.
  const cal = mail.attachments.filter((a) => /text\/calendar|application\/ics/i.test(a.contentType) || /\.ics$/i.test(a.filename ?? ""));
  if (cal.length) return { name, subject, via: "ics", drafts: cal.flatMap((a) => parseIcs(a.content.toString("utf8"), "email").drafts) };
  if (isLive()) {
    try {
      return { name, subject, via: "model", drafts: await llm(mail, id, state) };
    } catch (err) {
      return { name, subject, via: "heuristic", drafts: heuristic(mail, id), error: (err as Error).message };
    }
  }
  return { name, subject, via: "heuristic", drafts: heuristic(mail, id) };
}

// Drops drafts already in the calendar (same uid, or same title and start) and repeats within the batch.
export function dedupe(drafts: EventDraft[], state: UserState): { fresh: EventDraft[]; dupes: number } {
  const uids = new Set(state.events.map((e) => e.uid).filter(Boolean));
  const keys = new Set(state.events.map((e) => `${e.title.toLowerCase()}|${e.start}`));
  const fresh: EventDraft[] = [];
  for (const d of drafts) {
    const key = `${d.title.toLowerCase()}|${d.start}`;
    if ((d.uid && uids.has(d.uid)) || keys.has(key)) continue;
    if (d.uid) uids.add(d.uid);
    keys.add(key);
    fresh.push(d);
  }
  return { fresh, dupes: drafts.length - fresh.length };
}
