import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, stateKey, useAction, type ServerState } from "../api";
import type { Replay } from "./CommandBar";
import { ActivityPanel } from "./ActivityPanel";

// Demo-only controls, docked like a browser's developer tools: who we're acting as and replaying
// their requests, replaying any request file, and the agent trace. It lives outside the calendar spec, so the designer never sees or changes it.

// Who has a transcript of their requests to replay: Jordan, Mina and Sam as weeks of sentences made
// from their sample history, Rosa, Dev and Priya as the request files they were built from.
const WEEKLY = ["jordan", "mina", "sam"];
const FILES: Record<string, string> = import.meta.glob("../../samples/*.txt", { query: "?raw", import: "default", eager: true });
const transcriptOf = (id: string) => FILES[`../../samples/${id}.txt`]?.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const btn = "min-h-10 rounded-lg border border-[#3A3F48] px-3 text-sm text-white hover:bg-[#262A31] disabled:opacity-50";
const heading = "m-0 text-xs font-semibold uppercase tracking-wider text-faint";

// Empties the person, then sends their requests through the chat box one by one. Weekly
// transcripts apply each simulated week (and run the learner) after its last request; request
// files are parsed line by line like typed sentences.
function ReplayPerson({ user, state, progress, onReplay, onStop }: { user: string; state: ServerState; progress: { at: number; of: number; stopping?: boolean } | null; onReplay: (r: Omit<Replay, "id">) => void; onStop: () => void }) {
  const weekly = WEEKLY.includes(user);
  const file = transcriptOf(user);
  const [loading, setLoading] = useState(false);
  const qc = useQueryClient();
  const clear = async () => {
    await api(`/api/state/${user}/reset`, { blank: true });
    await qc.invalidateQueries({ queryKey: stateKey(user) });
  };
  const start = async () => {
    setLoading(true);
    try {
      if (!weekly) {
        await clear();
        onReplay({ lines: file!, fresh: true });
        return;
      }
      const { weeks } = await api<{ weeks: string[][] }>(`/api/learning/replay-plan/${user}?weeks=8`);
      await clear();
      const lines = weeks.flat();
      const where = weeks.flatMap((w, k) => w.map((_, line) => ({ week: k, line })));
      const post = (body: object) => api(`/api/learning/${user}/replay`, { persona: user, weeks: weeks.length, ...body });
      // Adds each request's events before the next request is typed, so the calendar grows with
      // the chat. A week's last request also runs the learner (and any empty weeks after it).
      const apply = async (i: number) => {
        let after = await post(where[i]);
        if (where[i].line === weeks[where[i].week].length - 1)
          for (let k = where[i].week + 1; k < weeks.length && !weeks[k].length; k++) after = await post({ week: k });
        await qc.invalidateQueries({ queryKey: stateKey(user) });
        return after;
      };
      onReplay({ lines, apply, fresh: true });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const has = weekly || !!file?.length;
  return (
    <div className="flex flex-col gap-2">
      {progress ? (
        <button type="button" onClick={onStop} disabled={progress.stopping} className={btn}>{progress.stopping ? "Stopping..." : `Stop (${progress.at} of ${progress.of})`}</button>
      ) : (
        <button type="button" disabled={!has || loading} onClick={start} className={btn}>
          {loading ? "Starting..." : !has ? "Replay requests" : weekly ? `Replay ${state.name}'s last 8 weeks` : `Replay ${state.name}'s requests`}
        </button>
      )}
      <p className="m-0 text-xs text-faint">
        {has
          ? `Empties ${state.name}'s calendar and what I've learned, then sends ${weekly ? "their requests week by week" : `their ${file!.length} requests one by one`} while both grow back.`
          : "No transcript of requests to replay for this person."}
      </p>
    </div>
  );
}

// Types a text file into the sentence box one line at a time, as if the person sent each one.
// Unlike Import > Text file, which reads the whole file as one previewed change.
function ReplayRequests({ progress, onStart, onStop }: { progress: { at: number; of: number; stopping?: boolean } | null; onStart: (lines: string[]) => void; onStop: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  return (
    <section aria-label="Replay requests" className="flex flex-col gap-2">
      <h2 className={heading}>Replay requests</h2>
      {progress ? (
        <button type="button" onClick={onStop} disabled={progress.stopping} className={`${btn} self-start`}>{progress.stopping ? "Stopping..." : `Stop (${progress.at} of ${progress.of})`}</button>
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
  progress: { at: number; of: number; stopping?: boolean } | null; onReplay: (r: Omit<Replay, "id">) => void; onStop: () => void;
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
          <button type="button" onClick={() => reset.mutate(undefined)} disabled={!!progress} className={btn}>Start over</button>
        </div>
        {state && <ReplayPerson user={user} state={state} progress={progress} onReplay={onReplay} onStop={onStop} />}
      </section>

      <ReplayRequests progress={progress} onStop={onStop} onStart={async (lines) => {
        await api(`/api/state/${user}/reset`, { blank: true });
        await qc.invalidateQueries({ queryKey: stateKey(user) });
        onReplay({ lines, fresh: true });
      }} />

      {state && <ActivityPanel steps={state.activity} mode={state.mode} busy={busy} onAsk={onAsk} />}
    </aside>
  );
}
