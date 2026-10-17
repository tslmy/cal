import type { CalEvent, Operation } from "./types";

// Applies operations to an event list and returns the new list plus the inverse operations,
// so every change set can be undone exactly (E12).
export function applyOps(events: CalEvent[], ops: Operation[], newId: () => string): { events: CalEvent[]; inverse: Operation[] } {
  let out = [...events];
  const inverse: Operation[] = [];
  for (const o of ops) {
    if (o.op === "create") {
      const ev = { ...o.event, id: o.event.id ?? newId() } as CalEvent;
      out.push(ev);
      inverse.unshift({ op: "delete", id: ev.id, before: ev });
    } else if (o.op === "update") {
      const cur = out.find((e) => e.id === o.id);
      if (!cur) continue;
      out = out.map((e) => (e.id === o.id ? { ...o.after, id: o.id } : e));
      inverse.unshift({ op: "update", id: o.id, before: { ...o.after, id: o.id }, after: cur });
    } else {
      const cur = out.find((e) => e.id === o.id);
      if (!cur) continue;
      out = out.filter((e) => e.id !== o.id);
      inverse.unshift({ op: "create", event: cur });
    }
  }
  return { events: out, inverse };
}

export const overlaps = (e: CalEvent, from: string, to: string) => e.start.slice(0, 10) <= to && e.end.slice(0, 10) >= from;
