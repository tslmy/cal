import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, stateKey, type ServerState } from "../api";
import type { CalendarSpec } from "../shared/catalog";
import { DAY_KEYS, mondayOf, TODAY } from "../shared/dates";

const year = Number(TODAY.slice(0, 4));
const ALL = [...DAY_KEYS];
const WORK = ALL.slice(0, 5);
const one = (type: string, props: Record<string, unknown>): CalendarSpec => ({ root: "view", elements: { view: { type, props, children: [] } } });

// Classic views anchored on today. Every one keeps the root key "view", so neighbouring presets re-render in place and animate their props.
const PRESETS: { label: string; spec: CalendarSpec }[] = [
  { label: "Month", spec: one("MonthGrid", { month: TODAY.slice(0, 7) }) },
  { label: "Week", spec: one("WeekGrid", { weekOf: mondayOf(TODAY), days: ALL, startHour: 7, endHour: 21 }) },
  { label: "Work week", spec: one("WeekGrid", { weekOf: mondayOf(TODAY), days: WORK, startHour: 7, endHour: 21 }) },
  { label: "Work hours", spec: one("WeekGrid", { weekOf: mondayOf(TODAY), days: WORK, startHour: 9, endHour: 17 }) },
  { label: "Year", spec: one("WeekStrip", { year, label: null }) },
  { label: "Years", spec: one("YearBand", { from: year, to: year + 4, labels: "calendar" }) },
];

// Compares views by what they show, ignoring element keys and prop order, so a designer spec that equals a preset still lights it up.
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "children").sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)])) : v;
const sig = (s: CalendarSpec) => JSON.stringify(Object.values(s.elements).map(canon));

// Manual view button group (P13). Updates the cache first so the morph starts on the tap, not after the round trip.
export function ViewSwitcher({ user, spec }: { user: string; spec: CalendarSpec }) {
  const qc = useQueryClient();
  const pick = useMutation({
    mutationFn: (p: (typeof PRESETS)[number]) => api(`/api/state/${user}/view`, { spec: p.spec, label: p.label }),
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: stateKey(user) });
      qc.setQueryData<ServerState>(stateKey(user), (s) => s && { ...s, spec: p.spec });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: stateKey(user) }),
  });
  const current = sig(spec);
  return (
    <div role="group" aria-label="Calendar view" className="flex w-fit max-w-full flex-wrap gap-1 rounded-xl bg-subtle p-1">
      {PRESETS.map((p) => {
        const active = sig(p.spec) === current;
        return (
          <button key={p.label} type="button" aria-pressed={active} onClick={() => !active && pick.mutate(p)}
            className={`min-h-9 rounded-lg px-3 text-sm font-medium ${active ? "bg-white text-ink shadow-sm ring-1 ring-line" : "text-muted hover:bg-white/60 hover:text-ink"}`}>
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
