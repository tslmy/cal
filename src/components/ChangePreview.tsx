import { useEffect, useRef } from "react";
import type { CalEvent, ChangeSet, Operation } from "../shared/types";
import { fmtWhen } from "../shared/when";

// Diff preview for any change set (typed sentence, text file, .ics, email) before it lands (P3).
const TONE = {
  create: { tag: "Add", cls: "bg-[#E3F3F0] text-[#0A5C53]" },
  update: { tag: "Move", cls: "bg-[#FDF1E3] text-[#8A4305]" },
  delete: { tag: "Remove", cls: "bg-[#FDECEC] text-[#9B1C1C]" },
} as const;

function Row({ o }: { o: Operation }) {
  const ev: Pick<CalEvent, "title" | "start" | "end" | "precision" | "category"> = o.op === "create" ? o.event : o.before;
  return (
    <li className="flex items-start gap-3 border-t border-line py-2 first:border-t-0">
      <span className={`mt-0.5 w-16 shrink-0 rounded-md px-1.5 py-0.5 text-center text-xs font-semibold ${TONE[o.op].cls}`}>{TONE[o.op].tag}</span>
      <div className="min-w-0 flex-1">
        <div className={`font-medium ${o.op === "delete" ? "text-muted line-through" : ""}`}>{ev.title}</div>
        <div className="text-sm text-muted">
          {o.op === "update" ? (
            <>
              <span className="line-through">{fmtWhen(o.before)}</span> <span aria-hidden>→</span><span className="sr-only">to</span>{" "}
              <span className="text-ink">{fmtWhen(o.after)}</span>
            </>
          ) : (
            fmtWhen(ev)
          )}
          <span className="text-faint"> · {ev.category}</span>
        </div>
      </div>
    </li>
  );
}

export function ChangePreview({ changeSet, onConfirm, onCancel, busy }: { changeSet: ChangeSet; onConfirm: () => void; onCancel: () => void; busy?: boolean }) {
  const confirm = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const hasOps = changeSet.ops.length > 0;
  useEffect(() => (hasOps ? confirm : close).current?.focus(), [changeSet.id, hasOps]);

  return (
    <section aria-label="Preview changes" onKeyDown={(e) => e.key === "Escape" && onCancel()} className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-4 shadow-sm">
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-display text-lg font-semibold">{changeSet.summary}</div>
        {hasOps && <div className="shrink-0 text-xs text-muted">{changeSet.ops.length} change{changeSet.ops.length === 1 ? "" : "s"}</div>}
      </div>
      {changeSet.answer && <p className="m-0 leading-relaxed">{changeSet.answer}</p>}
      {hasOps && <ul className="m-0 list-none p-0">{changeSet.ops.map((o, i) => <Row key={i} o={o} />)}</ul>}
      <div className="flex flex-wrap gap-2">
        {hasOps && (
          <button ref={confirm} type="button" disabled={busy} onClick={onConfirm} className="min-h-11 rounded-xl bg-ink px-4 font-semibold text-white disabled:opacity-60">
            {busy ? "Applying..." : `Apply ${changeSet.ops.length === 1 ? "change" : `${changeSet.ops.length} changes`}`}
          </button>
        )}
        <button ref={close} type="button" onClick={onCancel} className="min-h-11 rounded-xl border border-line-strong px-4">{hasOps ? "Cancel" : "Close"}</button>
      </div>
    </section>
  );
}
