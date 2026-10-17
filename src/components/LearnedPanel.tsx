import type { UserState } from "../shared/types";

// "What I've learned" (P11). Owned by the learning workstream.
export function LearnedPanel({ state }: { user: string; state: UserState }) {
  return (
    <section aria-label="What I've learned" className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-4">
      <h2 className="m-0 font-display text-base font-semibold">What I've learned about {state.name}</h2>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm">
        {state.beliefs.map((b) => (
          <li key={b.key} className="flex items-center justify-between gap-2">
            <span>{b.statement}</span>
            <span className="font-mono text-xs text-muted">{b.confidence.toFixed(2)}</span>
          </li>
        ))}
        {!state.beliefs.length && <li className="text-muted">Nothing yet. Use the calendar and I'll start noticing patterns.</li>}
      </ul>
    </section>
  );
}
