import type { TraceStep } from "../shared/types";

const TINTS: [RegExp, string][] = [
  [/^Habit/, "text-[#B9A6F2]"],
  [/^Meta/, "text-[#F2D16B]"],
  [/^Designer/, "text-[#8FD6C8]"],
  [/^Critic/, "text-[#F29B9B]"],
  [/^Calendar/, "text-[#9CC3F2]"],
];
const tint = (role: string) => TINTS.find(([re]) => re.test(role))?.[1] ?? "text-[#F2B36B]";

// Unified diff of a prompt rewrite, without the file headers.
function Diff({ diff }: { diff: string }) {
  const lines = diff.split("\n").filter((l) => !l.startsWith("---") && !l.startsWith("+++"));
  return (
    <pre className="m-0 mt-1.5 overflow-x-auto rounded-lg bg-[#0D0F13] p-2 font-mono text-[11px] leading-relaxed">
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith("+") ? "bg-[#12301F] text-[#9BE3B4]" : l.startsWith("-") ? "bg-[#3A1717] text-[#F2A5A5]" : l.startsWith("@@") ? "text-faint" : "text-[#AEB4BD]"}>{l || " "}</div>
      ))}
    </pre>
  );
}

// The whole agent loop as it runs (E9).
export function ActivityPanel({ steps, mode, busy, onAsk }: { steps: TraceStep[]; mode: string; busy: boolean; onAsk: () => void }) {
  return (
    <section aria-label="Agent activity" className="flex max-h-[32rem] flex-col gap-3 rounded-2xl bg-ink p-4 text-[#E8EAED]">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="m-0 font-display text-base font-semibold text-white">Agent activity</h2>
        <span className="font-mono text-[11px] text-faint">{busy ? "working..." : mode === "mock" ? "offline mock" : "live"}</span>
      </div>
      <ol className="m-0 flex min-h-0 flex-1 list-none flex-col-reverse gap-2.5 overflow-y-auto p-0">
        {[...steps].reverse().map((t, i) => (
          <li key={i} className="flex items-start gap-2.5">
            <span className={`min-w-20 flex-none rounded bg-[#262A31] px-1.5 py-0.5 text-center font-mono text-[11px] ${tint(t.role)}`}>{t.role}</span>
            <div className="min-w-0 flex-1 text-[13px] leading-snug text-[#D5D9DF]">
              {t.text}
              {t.diff && <Diff diff={t.diff} />}
            </div>
          </li>
        ))}
      </ol>
      <button type="button" disabled={busy} onClick={onAsk} className="min-h-11 flex-none self-start rounded-xl border border-[#3A3F48] px-4 text-sm font-medium text-white disabled:opacity-50">Ask the designer now</button>
    </section>
  );
}
