import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, stateKey, useAction, type ServerState } from "../api";
import type { Replay } from "./CommandBar";
import { ActivityPanel } from "./ActivityPanel";

// Demo-only controls, docked like a browser's developer tools: who we're acting as, time scrubbing
// and the agent trace. It lives outside the calendar spec, so the designer never sees or changes it.

const REPLAYS = [["jordan", "Jordan"], ["mina", "Mina"], ["sam", "Sam"]] as const;
const btn = "min-h-10 rounded-lg border border-[#3A3F48] px-3 text-sm text-white hover:bg-[#262A31] disabled:opacity-50";
const heading = "m-0 text-xs font-semibold uppercase tracking-wider text-faint";

// Starts this person over, then sends a sample person's last weeks through the chat box as
// requests, applying each simulated week (and running the learner) after its last request.
function Scrub({ user, state, progress, onReplay, onStop }: { user: string; state: ServerState; progress: { at: number; of: number } | null; onReplay: (r: Omit<Replay, "id">) => void; onStop: () => void }) {
  const [picked, setWho] = useState<(typeof REPLAYS)[number][0]>("jordan");
  // A sample person replays their own history, so acting as Jordan always shows Jordan's weeks.
  // Only someone without one (You, or a person built from a request file) borrows a sample's.
  const own = REPLAYS.find(([id]) => id === user)?.[0];
  const who = own ?? picked;
  const [loading, setLoading] = useState(false);
  const qc = useQueryClient();
  const name = REPLAYS.find(([id]) => id === who)![1];
  const start = async () => {
    setLoading(true);
    try {
      const { weeks } = await api<{ weeks: string[][] }>(`/api/learning/replay-plan/${who}?weeks=8`);
      await api(`/api/state/${user}/reset`, { blank: true });
      await qc.invalidateQueries({ queryKey: stateKey(user) });
      const lines = weeks.flat();
      const lastOf = weeks.map((_, k) => weeks.slice(0, k + 1).flat().length - 1);
      let done = 0; // weeks applied so far
      const apply = async (i: number) => {
        // Applies every week whose last request has now been sent (empty weeks ride along).
        let after: ServerState | undefined;
        while (done < weeks.length && (lastOf[done] <= i || i === lines.length - 1)) {
          after = await api(`/api/learning/${user}/replay`, { persona: who, weeks: weeks.length, week: done });
          done++;
          await qc.invalidateQueries({ queryKey: stateKey(user) });
        }
        return after;
      };
      onReplay({ lines, apply, fresh: true });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const busy = loading || !!progress;
  return (
    <section aria-label="Scrub time forward" className="flex flex-col gap-2">
      <h2 className={heading}>Scrub time forward</h2>
      <div className="flex gap-2">
        {!own && (
          <select aria-label="Sample person" value={who} onChange={(e) => setWho(e.target.value as typeof who)} disabled={busy}
            className="min-h-10 rounded-lg border border-[#3A3F48] bg-ink px-2 text-sm text-white">
            {REPLAYS.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </select>
        )}
        {progress ? (
          <button type="button" onClick={onStop} className={`${btn} flex-1`}>Stop ({progress.at} of {progress.of})</button>
        ) : (
          <button type="button" disabled={busy} onClick={start} className={`${btn} flex-1`}>
            {busy ? "Starting..." : `Replay ${name}'s last 8 weeks`}
          </button>
        )}
      </div>
      <p className="m-0 text-xs text-faint">
        Empties {state.name}'s calendar and what I've learned, then sends {own ? "their" : `${name}'s`} requests week by week while both grow back.
      </p>
    </section>
  );
}

// Types a text file into the sentence box one line at a time, as if the person sent each one.
// Unlike Import > Text file, which reads the whole file as one previewed change.
function ReplayRequests({ progress, onStart, onStop }: { progress: { at: number; of: number } | null; onStart: (lines: string[]) => void; onStop: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  return (
    <section aria-label="Replay requests" className="flex flex-col gap-2">
      <h2 className={heading}>Replay requests</h2>
      {progress ? (
        <button type="button" onClick={onStop} className={`${btn} self-start`}>Stop ({progress.at} of {progress.of})</button>
      ) : (
        <button type="button" onClick={() => file.current?.click()} className={`${btn} self-start`}>Choose a text file</button>
      )}
      <input ref={file} type="file" hidden accept=".txt,text/plain" onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) onStart((await f.text()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
      }} />
      <p className="m-0 text-xs text-faint">Empties this calendar first. One request per line; each is typed into the box, sent and applied without review.</p>
    </section>
  );
}

export function DevTools({ open, onToggle, user, onUser, state, users, busy, onAsk, progress, onReplay, onStop }: {
  open: boolean; onToggle: () => void; user: string; onUser: (id: string) => void; state?: ServerState;
  users: { id: string; name: string; role: string }[]; busy: boolean; onAsk: () => void;
  progress: { at: number; of: number } | null; onReplay: (r: Omit<Replay, "id">) => void; onStop: () => void;
}) {
  const reset = useAction(user, () => api(`/api/state/${user}/reset`, {}));
  const qc = useQueryClient();
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
        <div className="flex gap-2">
          <select aria-label="Act as" value={user} onChange={(e) => onUser(e.target.value)} disabled={!!progress}
            className="min-h-10 min-w-0 flex-1 rounded-lg border border-[#3A3F48] bg-ink px-2 text-sm text-white">
            {users.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.role})</option>)}
          </select>
        <button type="button" onClick={() => reset.mutate(undefined)} className={btn}>Start over</button>
        </div>
      </section>

      <ReplayRequests progress={progress} onStop={onStop} onStart={async (lines) => {
        await api(`/api/state/${user}/reset`, { blank: true });
        await qc.invalidateQueries({ queryKey: stateKey(user) });
        onReplay({ lines, fresh: true });
      }} />

      {state && <Scrub user={user} state={state} progress={progress} onReplay={onReplay} onStop={onStop} />}
      {state && <ActivityPanel steps={state.activity} mode={state.mode} busy={busy} onAsk={onAsk} />}
    </aside>
  );
}
