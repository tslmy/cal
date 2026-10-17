import type { TraceStep } from "../shared/types";

const tint = (role: string) => (role === "Critic" ? "text-[#F29B9B]" : role.startsWith("Designer ") ? "text-[#8FD6C8]" : "text-[#F2B36B]");

// The whole agent loop as it runs (E9).
export function ActivityPanel({ steps, mode, busy, onAsk }: { steps: TraceStep[]; mode: string; busy: boolean; onAsk: () => void }) {
  return (
    <section aria-label="Agent activity" className="flex flex-col gap-3 rounded-2xl bg-ink p-4 text-[#E8EAED]">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="m-0 font-display text-base font-semibold text-white">Agent activity</h2>
        <span className="font-mono text-[11px] text-faint">{busy ? "working..." : mode === "mock" ? "offline mock" : "live"}</span>
      </div>
      <ol className="m-0 flex max-h-[28rem] list-none flex-col-reverse gap-2.5 overflow-y-auto p-0">
        {[...steps].reverse().map((t, i) => (
          <li key={i} className="flex items-start gap-2.5">
            <span className={`min-w-20 flex-none rounded bg-[#262A31] px-1.5 py-0.5 text-center font-mono text-[11px] ${tint(t.role)}`}>{t.role}</span>
            <span className="text-[13px] leading-snug text-[#D5D9DF]">{t.text}</span>
          </li>
        ))}
      </ol>
      <button type="button" disabled={busy} onClick={onAsk} className="min-h-11 self-start rounded-xl border border-[#3A3F48] px-4 text-sm font-medium text-white disabled:opacity-50">Ask the designer now</button>
    </section>
  );
}
