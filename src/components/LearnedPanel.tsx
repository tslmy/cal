import { useState } from "react";
import { api, useAction } from "../api";
import type { Belief, UserState } from "../shared/types";

const GAPS: [number, string][] = [[0, "As soon as a habit is clear"], [30, "At most every 30 minutes"], [240, "At most every 4 hours"], [1440, "At most once a day"]];
const REPLAYS = [["jordan", "Jordan"], ["mina", "Mina"], ["sam", "Sam"]] as const;

function BeliefRow({ b, threshold, onDelete }: { b: Belief; threshold: number; onDelete: () => void }) {
  const above = b.confidence >= threshold;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm leading-snug">{b.statement}</span>
        <button type="button" onClick={onDelete} aria-label={`Forget: ${b.statement}`} title="Forget this"
          className="-mr-1 -mt-0.5 flex size-7 flex-none items-center justify-center rounded-lg text-faint hover:bg-subtle hover:text-ink">×</button>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative h-1.5 flex-1 rounded-full bg-line" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={b.confidence} aria-label="Confidence">
          <div className={`h-full rounded-full transition-[width] duration-500 ${above ? "bg-accent" : "bg-faint"}`} style={{ width: `${b.confidence * 100}%` }} />
          <div className="absolute -top-1 h-3.5 w-px bg-ink" style={{ left: `${threshold * 100}%` }} />
        </div>
        <span className={`w-9 text-right font-mono text-xs ${above ? "text-accent" : "text-muted"}`}>{b.confidence.toFixed(2)}</span>
      </div>
      <span className="text-xs text-faint">{b.evidence.length ? `${b.evidence.length} logged signal${b.evidence.length === 1 ? "" : "s"}` : "From the sample profile"}</span>
    </li>
  );
}

// "What I've learned" (P11, P12): beliefs with their confidence against the proposal threshold,
// how the person likes to be adapted, and the knobs for how often suggestions come.
export function LearnedPanel({ user, state }: { user: string; state: UserState }) {
  const [who, setWho] = useState<(typeof REPLAYS)[number][0]>("jordan");
  const forget = useAction(user, (key: string) => api(`/api/learning/${user}/beliefs/${encodeURIComponent(key)}/delete`, {}));
  const settings = useAction(user, (body: Partial<UserState["settings"]>) => api(`/api/learning/${user}/settings`, body));
  const replay = useAction(user, () => api(`/api/learning/${user}/replay`, { persona: who, weeks: 8 }));

  const { threshold, proposalsOn, minGapMinutes } = state.settings;
  const habits = state.beliefs.filter((b) => b.level === "habit").sort((a, b) => b.confidence - a.confidence);
  const meta = state.beliefs.filter((b) => b.level === "meta");
  const gaps = GAPS.some(([m]) => m === minGapMinutes) ? GAPS : [...GAPS, [minGapMinutes, `At most every ${minGapMinutes} minutes`] as [number, string]];
  const lastReplay = state.activity.findLast((a) => a.role === "Replay");
  const replaying = replay.isPending || (!!lastReplay && !lastReplay.text.startsWith("Done"));
  const name = REPLAYS.find(([id]) => id === who)![1];

  return (
    <section aria-label="What I've learned" className="flex flex-col gap-4 rounded-2xl border border-line bg-white p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="m-0 font-display text-base font-semibold">What I've learned about {state.name}</h2>
        <span className="flex items-center gap-1.5 text-xs text-muted"><span className="inline-block h-3 w-px bg-ink" />suggest at {threshold.toFixed(2)}</span>
      </div>

      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {habits.map((b) => <BeliefRow key={b.key} b={b} threshold={threshold} onDelete={() => forget.mutate(b.key)} />)}
        {!habits.length && <li className="text-sm text-muted">Nothing yet. Use the calendar and I'll start noticing patterns.</li>}
      </ul>

      {meta.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <h3 className="m-0 text-xs font-semibold uppercase tracking-wider text-muted">How you like to be adapted</h3>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {meta.map((b) => <BeliefRow key={b.key} b={b} threshold={threshold} onDelete={() => forget.mutate(b.key)} />)}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3 text-sm">
        <label className="flex min-h-11 cursor-pointer items-center gap-2">
          <button type="button" role="switch" aria-checked={proposalsOn} onClick={() => settings.mutate({ proposalsOn: !proposalsOn })}
            className={`relative h-6 w-10 flex-none rounded-full transition-colors ${proposalsOn ? "bg-accent" : "bg-line-strong"}`}>
            <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-[left] ${proposalsOn ? "left-[18px]" : "left-0.5"}`} />
          </button>
          Suggestions
        </label>
        <label className="flex min-w-0 flex-1 items-center gap-2">
          <span className="sr-only">How often</span>
          <select value={minGapMinutes} disabled={!proposalsOn} onChange={(e) => settings.mutate({ minGapMinutes: Number(e.target.value) })}
            className="min-h-11 w-full min-w-0 rounded-xl border border-line-strong bg-white px-2.5 disabled:opacity-50">
            {gaps.map(([m, label]) => <option key={m} value={m}>{label}</option>)}
          </select>
        </label>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-dashed border-line-strong p-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted">Demo: scrub time forward</div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Sample person" value={who} onChange={(e) => setWho(e.target.value as typeof who)} disabled={replaying}
            className="min-h-11 rounded-xl border border-line-strong bg-white px-2.5 text-sm">
            {REPLAYS.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </select>
          <button type="button" disabled={replaying} onClick={() => replay.mutate(undefined)}
            className="min-h-11 flex-1 rounded-xl border border-line-strong bg-white px-3 text-sm font-medium disabled:opacity-50">
            {replaying ? "Replaying..." : `Replay ${name}'s last 8 weeks`}
          </button>
        </div>
        <div className="text-xs text-faint">Feeds {name}'s events and visits into {state.name}'s log, one simulated week at a time.</div>
      </div>
    </section>
  );
}
