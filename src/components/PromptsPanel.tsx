import { api, useAction } from "../api";
import type { AgentName, UserState } from "../shared/types";

const AGENTS: AgentName[] = ["designer", "intent", "importer", "habit", "meta"];

// Each agent's learned "About this person" section, its versions and rollback (E6, E7).
export function PromptsPanel({ user, state }: { user: string; state: UserState }) {
  const rollback = useAction(user, ({ agent, version }: { agent: AgentName; version: number }) => api(`/api/prompts/${user}/${agent}/rollback`, { version }));
  const written = AGENTS.filter((a) => state.prompts.some((p) => p.agent === a));
  return (
    <section aria-label="Agent prompts" className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-4">
      <h2 className="m-0 font-display text-base font-semibold">What each agent is told about {state.name}</h2>
      {!written.length && <p className="m-0 text-sm text-muted">The meta-learner rewrites these once it sees how {state.name} reacts to suggestions.</p>}
      {written.map((agent) => {
        const versions = state.prompts.filter((p) => p.agent === agent);
        const active = versions.find((p) => p.active);
        return (
          <details key={agent} className="group rounded-xl border border-line px-3 py-2">
            <summary className="flex min-h-9 cursor-pointer items-center justify-between gap-2 text-sm">
              <span className="font-semibold capitalize">{agent}</span>
              <span className="font-mono text-xs text-muted">{active ? `v${active.version}` : "core only"} · {versions.length} version{versions.length > 1 ? "s" : ""}</span>
            </summary>
            <pre className="m-0 mt-2 whitespace-pre-wrap rounded-lg bg-subtle p-2 font-mono text-[11px] leading-relaxed text-ink-soft">{active?.learned ?? "No learned section: the agent runs on its core prompt."}</pre>
            <ol className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
              {[...versions].reverse().map((v) => (
                <li key={v.version} className="flex items-start justify-between gap-2 border-t border-line pt-2 text-xs">
                  <div className="min-w-0">
                    <div className="font-mono">
                      v{v.version}
                      {v.active && <span className="ml-1.5 rounded bg-[#E3F3F0] px-1 text-accent">active</span>}
                      {v.replay && <span className={`ml-1.5 rounded px-1 ${v.replay.ok ? "bg-subtle text-muted" : "bg-[#FDECEC] text-[#A12B2B]"}`}>replay {v.replay.ok ? "passed" : "failed"}</span>}
                    </div>
                    <div className="mt-0.5 text-muted">{v.reason}</div>
                    {v.replay && <div className="mt-0.5 text-faint">{v.replay.notes.join("; ")}</div>}
                  </div>
                  {!v.active && (
                    <button type="button" disabled={rollback.isPending} onClick={() => rollback.mutate({ agent, version: v.version })} className="min-h-8 flex-none rounded-lg border border-line-strong px-2.5 disabled:opacity-50">Use v{v.version}</button>
                  )}
                </li>
              ))}
              {active && (
                <li className="flex justify-end border-t border-line pt-2 text-xs">
                  <button type="button" disabled={rollback.isPending} onClick={() => rollback.mutate({ agent, version: 0 })} className="min-h-8 rounded-lg border border-line-strong px-2.5 disabled:opacity-50">Back to core only</button>
                </li>
              )}
            </ol>
          </details>
        );
      })}
    </section>
  );
}
