import type { ChangeSet, Operation } from "../shared/types";

// Diff preview for any change set (typed sentence, text file, .ics, email) before it lands (P3).
// Minimal version; the intent workstream owns its look.
const label = (o: Operation) =>
  o.op === "create" ? `+ ${o.event.title} (${o.event.start} to ${o.event.end})`
  : o.op === "delete" ? `- ${o.before.title} (${o.before.start})`
  : `~ ${o.before.title}: ${o.before.start} to ${o.after.start}`;

export function ChangePreview({ changeSet, onConfirm, onCancel, busy }: { changeSet: ChangeSet; onConfirm: () => void; onCancel: () => void; busy?: boolean }) {
  return (
    <section aria-label="Preview changes" className="flex flex-col gap-2 rounded-2xl border border-line bg-white p-4">
      <div className="font-semibold">{changeSet.summary}</div>
      {changeSet.answer && <p className="m-0">{changeSet.answer}</p>}
      <ul className="m-0 list-none p-0 font-mono text-xs">{changeSet.ops.map((o, i) => <li key={i}>{label(o)}</li>)}</ul>
      <div className="flex gap-2">
        {changeSet.ops.length > 0 && <button type="button" disabled={busy} onClick={onConfirm} className="min-h-11 rounded-xl bg-ink px-4 font-semibold text-white">Apply</button>}
        <button type="button" onClick={onCancel} className="min-h-11 rounded-xl border border-line-strong px-4">{changeSet.ops.length ? "Cancel" : "Close"}</button>
      </div>
    </section>
  );
}
