import { useState } from "react";
import { api, useAction, type ServerState } from "../api";
import { ActivityPanel } from "./ActivityPanel";

// Demo-only controls, docked like a browser's developer tools: who we're acting as, time scrubbing
// and the agent trace. It lives outside the calendar spec, so the designer never sees or changes it.

const REPLAYS = [["jordan", "Jordan"], ["mina", "Mina"], ["sam", "Sam"]] as const;
const btn = "min-h-10 rounded-lg border border-[#3A3F48] px-3 text-sm text-white hover:bg-[#262A31] disabled:opacity-50";
const heading = "m-0 text-xs font-semibold uppercase tracking-wider text-faint";

function Scrub({ user, state }: { user: string; state: ServerState }) {
  const [who, setWho] = useState<(typeof REPLAYS)[number][0]>("jordan");
  const replay = useAction(user, () => api(`/api/learning/${user}/replay`, { persona: who, weeks: 8 }));
  const last = state.activity.findLast((a) => a.role === "Replay");
  const busy = replay.isPending || (!!last && !last.text.startsWith("Done"));
  const name = REPLAYS.find(([id]) => id === who)![1];
  return (
    <section aria-label="Scrub time forward" className="flex flex-col gap-2">
      <h2 className={heading}>Scrub time forward</h2>
      <div className="flex gap-2">
        <select aria-label="Sample person" value={who} onChange={(e) => setWho(e.target.value as typeof who)} disabled={busy}
          className="min-h-10 rounded-lg border border-[#3A3F48] bg-ink px-2 text-sm text-white">
          {REPLAYS.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
        </select>
        <button type="button" disabled={busy} onClick={() => replay.mutate(undefined)} className={`${btn} flex-1`}>
          {busy ? "Replaying..." : `Replay ${name}'s last 8 weeks`}
        </button>
      </div>
      <p className="m-0 text-xs text-faint">Feeds {name}'s events and visits into {state.name}'s log, one simulated week at a time.</p>
    </section>
  );
}

export function DevTools({ open, onToggle, user, onUser, state, users, busy, onAsk }: {
  open: boolean; onToggle: () => void; user: string; onUser: (id: string) => void; state?: ServerState;
  users: { id: string; name: string; role: string }[]; busy: boolean; onAsk: () => void;
}) {
  const reset = useAction(user, () => api(`/api/state/${user}/reset`, {}));
  if (!open)
    return (
      <button type="button" onClick={onToggle} aria-expanded={false}
        className="fixed right-0 top-24 z-40 rounded-l-lg bg-ink px-2 py-3 font-mono text-xs text-white [writing-mode:vertical-rl]">
        Developer tools
      </button>
    );
  return (
    <aside aria-label="Developer tools" className="fixed inset-y-0 right-0 z-40 flex w-[min(380px,100vw)] flex-col gap-5 overflow-hidden bg-ink p-4 text-[#E8EAED] shadow-2xl">
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm text-white">Developer tools</span>
        <button type="button" onClick={onToggle} aria-expanded aria-label="Close developer tools" className="flex size-8 items-center justify-center rounded-lg text-faint hover:bg-[#262A31] hover:text-white">×</button>
      </div>

      <section aria-label="Act as" className="flex flex-col gap-2">
        <h2 className={heading}>Act as</h2>
        <div className="grid grid-cols-2 gap-2">
          {users.map((p) => (
            <button key={p.id} type="button" aria-pressed={p.id === user} onClick={() => onUser(p.id)}
              className={`flex flex-col items-start rounded-lg border px-3 py-1.5 text-left text-sm leading-tight ${p.id === user ? "border-white bg-white text-ink" : "border-[#3A3F48] text-white hover:bg-[#262A31]"}`}>
              <span className="font-semibold">{p.name}</span>
              <span className={`text-xs ${p.id === user ? "text-muted" : "text-faint"}`}>{p.role}</span>
            </button>
          ))}
        </div>
        <button type="button" onClick={() => reset.mutate(undefined)} className={`${btn} self-start`}>Start {state?.name ?? "this person"} over</button>
      </section>

      {state && <Scrub user={user} state={state} />}
      {state && <ActivityPanel steps={state.activity} mode={state.mode} busy={busy} onAsk={onAsk} />}
    </aside>
  );
}
