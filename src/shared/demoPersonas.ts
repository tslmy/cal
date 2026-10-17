import type { CalEvent, Persona } from "./types";
import { addDays, DAY_KEYS, weekday, type DayKey } from "./dates";

// Demo personas built from the request files in samples/ (rosa.txt, dev.txt, priya.txt): their
// events are what those requests add up to, and each starts with the view the live designer
// proposed for them in the persona run, already accepted, so the demo can show it (and undo it).

type E = [title: string, start: string, end: string, category: string, precision?: CalEvent["precision"]];
const make = (prefix: string, list: E[]): CalEvent[] =>
  list.map(([title, start, end, category, precision], i) => ({ id: `${prefix}${i}`, title, start, end, category, precision: precision ?? (start.length > 10 ? "exact" : "day"), source: "typed" }));

// Weekly occurrences from `from` through `to` on the given days, minus `skip` dates.
function weekly(title: string, days: DayKey[], from: string, to: string, startHm: string, endHm: string, category: string, skip: string[] = []): E[] {
  const out: E[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!days.includes(DAY_KEYS[weekday(d)]) || skip.includes(d)) continue;
    const endDay = endHm < startHm ? addDays(d, 1) : d;
    out.push([title, `${d}T${startHm}`, `${endDay}T${endHm}`, category]);
  }
  return out;
}

const rosa = make("r", [
  ["Call my sister back", "2026-10-17T15:00", "2026-10-17T16:00", "Social", "approximate"],
  ["Pick up groceries", "2026-10-17T13:00", "2026-10-17T14:00", "Errands", "approximate"],
  ["Make soup", "2026-10-17T14:00", "2026-10-17T15:00", "Home", "approximate"],
  ["Nap", "2026-10-17T16:00", "2026-10-17T17:00", "Home", "approximate"],
  ["Church", "2026-10-18T10:00", "2026-10-18T11:00", "Personal", "approximate"],
  ["Lunch with Mom", "2026-10-18T12:00", "2026-10-18T13:00", "Social", "approximate"],
  ["Water the plants", "2026-10-18T14:00", "2026-10-18T15:00", "Home", "approximate"],
  ["Watch the movie with Jorge", "2026-10-18T20:00", "2026-10-18T22:00", "Social", "approximate"],
  ["Doctor appointment", "2026-10-19T09:30", "2026-10-19T10:30", "Health"],
  ["Pharmacy pickup", "2026-10-19T11:00", "2026-10-19T12:00", "Health", "approximate"],
  ["Pay the electric bill", "2026-10-20T10:00", "2026-10-20T11:00", "Errands", "approximate"],
  ["Call the bank about the card", "2026-10-20T12:00", "2026-10-20T12:30", "Errands", "approximate"],
  ["Walk the dog", "2026-10-20T18:00", "2026-10-20T19:00", "Home", "approximate"],
  ["Coffee with Linda", "2026-10-21T15:00", "2026-10-21T16:00", "Social", "approximate"],
  ["Clean the kitchen", "2026-10-22", "2026-10-22", "Home"],
  ["Water the plants", "2026-10-22", "2026-10-22", "Home"],
  ["Phone call with my grandson", "2026-10-22T19:00", "2026-10-22T20:00", "Family", "approximate"],
  ["Hair appointment", "2026-10-23T11:45", "2026-10-23T12:45", "Personal"],
  ["Return library books", "2026-10-23T14:00", "2026-10-23T15:00", "Errands", "approximate"],
  ["Dinner at Jorge's", "2026-10-23T18:00", "2026-10-23T20:00", "Social", "approximate"],
  ["Bake cookies for the neighbors", "2026-10-24T14:00", "2026-10-24T16:00", "Home", "approximate"],
  ["Visit Aunt Carmen", "2026-10-25", "2026-10-25", "Family"],
  ["Farmers market", "2026-10-31T10:00", "2026-10-31T12:00", "Errands", "approximate"],
  ["Flu shot", "2026-11-02", "2026-11-08", "Health", "week"],
]);

const nights = (dates: string[]) => dates.map((d): E => ["Night shift", `${d}T19:00`, `${addDays(d, 1)}T07:00`, "Work"]);
const sleeps = (dates: string[]) => dates.map((d): E => ["Sleep", `${d}T08:00`, `${d}T15:00`, "Rest"]);
const dev = make("d", [
  ...nights(["2026-10-17", "2026-10-18", "2026-10-21", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-04", "2026-11-05", "2026-11-06"]),
  ...sleeps(["2026-10-18", "2026-10-27", "2026-10-28", "2026-10-31", "2026-11-01", "2026-11-02"]),
  ["Days off", "2026-10-19", "2026-10-20", "Personal"],
  ["Gym", "2026-10-19T16:00", "2026-10-19T17:00", "Health"],
  ["Call Mom", "2026-10-19T18:00", "2026-10-19T18:30", "Family"],
  ["Groceries", "2026-10-20T14:00", "2026-10-20T15:00", "Errands"],
  ["Dentist", "2026-10-20T15:00", "2026-10-20T16:00", "Health"],
  ["Call the pharmacy about my refill", "2026-10-20T16:00", "2026-10-20T16:30", "Health"],
  ["Movie night with Kim", "2026-10-21T23:00", "2026-10-22T01:00", "Social"],
  ["Breakfast with Kim", "2026-10-23T07:30", "2026-10-23T08:30", "Social"],
  ["Oil change", "2026-10-23T14:00", "2026-10-23T15:00", "Errands"],
  ["Unit meeting", "2026-10-23T18:00", "2026-10-23T19:00", "Work"],
  ["Breakfast with the night crew", "2026-10-26T08:00", "2026-10-26T09:00", "Social"],
  ["Mandatory training", "2026-10-28T13:00", "2026-10-28T16:00", "Work"],
  ["Nap", "2026-10-28T16:30", "2026-10-28T18:30", "Rest"],
  ["Gym", "2026-10-29T15:00", "2026-10-29T16:00", "Health"],
  ["Pay rent", "2026-11-01", "2026-11-01", "Errands"],
  ["Vacation", "2026-11-16", "2026-11-22", "Travel", "span"],
]);

const priya = make("p", [
  ...weekly("Ava: soccer practice", ["tue", "thu"], "2026-10-20", "2026-11-19", "16:30", "18:00", "Ava", ["2026-10-22"]),
  ...weekly("Leo: swim lesson", ["sat"], "2026-10-31", "2026-12-19", "09:00", "09:45", "Leo"),
  ["Leo: swim lesson", "2026-10-25T09:00", "2026-10-25T09:45", "Leo"],
  ...weekly("Leo: reading", ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], "2026-10-17", "2026-11-15", "19:30", "19:50", "Leo", ["2026-10-18"]),
  ...weekly("My yoga", ["mon", "wed"], "2026-10-19", "2026-12-16", "07:00", "08:00", "Me", ["2026-10-21"]),
  ...weekly("Family movie night", ["fri"], "2026-10-23", "2026-12-18", "19:00", "21:00", "Family", ["2026-10-30"]),
  ["Ava: soccer game at Riverside Park", "2026-10-17T13:00", "2026-10-17T14:00", "Ava"],
  ["Grocery run", "2026-10-18T10:00", "2026-10-18T11:00", "Errands", "approximate"],
  ["Halloween costume shopping", "2026-10-18T14:00", "2026-10-18T16:00", "Family", "approximate"],
  ["Ava: dentist", "2026-10-19T15:45", "2026-10-19T16:45", "Ava"],
  ["Ava: piano lesson", "2026-10-21T17:00", "2026-10-21T18:00", "Ava"],
  ["Leo: parent-teacher conference", "2026-10-22T15:15", "2026-10-22T15:45", "Leo"],
  ["Leo: playdate with Sami", "2026-10-23T15:30", "2026-10-23T17:30", "Leo"],
  ["Send invites for Leo's party", "2026-10-24", "2026-10-24", "Leo"],
  ["Theo: work trip", "2026-10-28", "2026-10-30", "Theo", "span"],
  ["Book fair volunteering", "2026-10-30T12:00", "2026-10-30T14:00", "Me"],
  ["Pumpkin carving", "2026-10-30T18:00", "2026-10-30T19:30", "Family"],
  ["Trick or treating with Leo", "2026-10-31T17:30", "2026-10-31T19:30", "Leo"],
  ["Ava: party drop-off", "2026-10-31T18:00", "2026-10-31T21:00", "Ava"],
  ["Kids' flu shots", "2026-11-04T16:00", "2026-11-04T17:00", "Family"],
  ["Ava: picture day", "2026-11-05", "2026-11-05", "Ava"],
  ["My dentist", "2026-11-06T10:00", "2026-11-06T11:00", "Me"],
  ["Leo's birthday party at the trampoline park", "2026-11-07T14:00", "2026-11-07T16:00", "Leo"],
  ["Theo's mom visits", "2026-11-12", "2026-11-15", "Family", "span"],
  ["Thanksgiving at my parents'", "2026-11-26", "2026-11-26", "Family"],
]);

export const DEMO_PERSONAS: Persona[] = [
  {
    id: "rosa", name: "Rosa", role: "Soft times",
    profile: {
      facts: ["19 of 24 events have rough times (\"around 10\", \"sometime Monday\")", "Plans mostly within the next two weeks", "One plan a few weeks out: the flu shot, week of Nov 2"],
      signals: { timeScales: ["month", "year"], roughTimes: true, weekendEvents: true },
      confidence: 0.81,
    },
    events: rosa,
    tailored: {
      title: "Keep the year in view under your month?",
      reason: "19 of your 24 plans have rough times and live in the next two weeks, but the flu shot is in November. A year band under the month keeps it in sight.",
      spec: { root: "s", elements: {
        s: { type: "Stack", props: { direction: "column", gap: "md" }, children: ["m", "y"] },
        m: { type: "MonthGrid", props: { month: "2026-10" }, children: [] },
        y: { type: "YearBand", props: { from: 2026, to: 2026, labels: "calendar" }, children: [] },
      } },
    },
  },
  {
    id: "dev", name: "Dev", role: "Night shifts",
    profile: {
      facts: ["13 overnight shifts, 7 PM to 7 AM", "The rotation changes every week", "Sleeps 8 AM to 3 PM after nights"],
      signals: { timeScales: ["week", "year"], overnight: true, rotation: true, weekendEvents: true },
      confidence: 0.84,
    },
    events: dev,
    tailored: {
      title: "See your week from 8 AM to midnight, with the year below?",
      reason: "13 of your events are overnight shifts that start at 7 PM, and the rotation changes week to week. A week running to midnight shows each shift's start; the 52-week strip shows the pattern and your vacation.",
      spec: { root: "s", elements: {
        s: { type: "Stack", props: { direction: "column", gap: "md" }, children: ["w", "y"] },
        w: { type: "WeekGrid", props: { weekOf: "2026-10-26", days: [...DAY_KEYS], startHour: 8, endHour: 24 }, children: [] },
        y: { type: "WeekStrip", props: { year: 2026, label: "Shifts across the year" }, children: [] },
      } },
    },
  },
  {
    id: "priya", name: "Priya", role: "Family logistics",
    profile: {
      facts: ["Plans for Ava, Leo and Theo as well as herself", "Most events are timed, 9 AM to 9 PM", "Recurring kids' activities every week"],
      signals: { timeScales: ["week", "day"], people: ["Ava", "Leo", "Theo"], weekendEvents: true },
      confidence: 0.8,
    },
    events: priya,
    tailored: {
      title: "Show this week from 9 AM to 9 PM?",
      reason: "Almost all of your family's plans are timed between 9 AM and 9 PM, with practices and lessons repeating every week. An hour-by-hour week shows who needs to be where.",
      spec: { root: "w", elements: {
        w: { type: "WeekGrid", props: { weekOf: "2026-10-19", days: [...DAY_KEYS], startHour: 9, endHour: 21 }, children: [] },
      } },
    },
  },
];
