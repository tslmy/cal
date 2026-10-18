import { MONTHS, parseDay, TODAY } from "./dates";
import type { CalEvent, Precision } from "./types";

// Human wording for an event's time, shared by the intent agent's answers and the change preview.
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function fmtDate(s: string): string {
  const d = parseDay(s);
  const year = s.slice(0, 4) === TODAY.slice(0, 4) ? "" : ` ${s.slice(0, 4)}`;
  return `${WD[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${year}`;
}

export function fmtWhen(e: Pick<CalEvent, "start" | "end" | "precision">): string {
  if (e.start.length <= 10) {
    if (e.start === e.end) return fmtDate(e.start);
    return `${e.precision === "week" ? "Sometime " : ""}${fmtDate(e.start)} to ${fmtDate(e.end)}`;
  }
  const t = e.start.slice(11, 16);
  if (e.precision === "approximate") return `${fmtDate(e.start)}, around ${t}`;
  const sameDay = e.start.slice(0, 10) === e.end.slice(0, 10);
  return `${fmtDate(e.start)}, ${t} to ${sameDay ? e.end.slice(11, 16) : `${fmtDate(e.end)} ${e.end.slice(11, 16)}`}`;
}

export const PRECISIONS: { value: Precision; label: string }[] = [
  { value: "exact", label: "Exact time" },
  { value: "approximate", label: "Around" },
  { value: "day", label: "All day" },
  { value: "week", label: "Sometime that week" },
  { value: "span", label: "Span" },
];
