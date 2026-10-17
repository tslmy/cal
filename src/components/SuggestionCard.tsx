import type { Proposal } from "../shared/types";

// Buttons are disabled while a reaction is on its way, so a double click can't accept twice.
export function SuggestionCard({ proposal, busy, onAccept, onDismiss }: { proposal: Proposal; busy?: boolean; onAccept: () => void; onDismiss: () => void }) {
  return (
    <section aria-label="Suggestion" className="flex flex-col gap-2.5 rounded-2xl border border-[#F0CFA5] bg-[#FDF1E3] p-4">
      <div className="text-xs font-semibold uppercase tracking-wider text-[#8A4305]">Suggestion</div>
      <h2 className="m-0 font-display text-xl font-semibold">{proposal.title}</h2>
      <p className="m-0 leading-relaxed text-[#3C2A17]">{proposal.reason}</p>
      <div className="flex flex-wrap gap-2 pt-1">
        <button type="button" onClick={onAccept} disabled={busy} className="min-h-11 rounded-xl bg-ink px-4 font-semibold text-white disabled:opacity-60">Try it</button>
        <button type="button" onClick={onDismiss} disabled={busy} className="min-h-11 rounded-xl border border-[#D9B48A] px-4 font-medium disabled:opacity-60">Not now</button>
      </div>
      <div className="text-xs text-[#6B4A26]">Nothing changes until you say so, and you can undo in one click.</div>
    </section>
  );
}

export function ActiveChange({ proposal, busy, onRevert }: { proposal: Proposal; busy?: boolean; onRevert: () => void }) {
  return (
    <section aria-label="What changed" className="flex flex-col gap-2 rounded-2xl border border-[#A9D8CF] bg-[#E3F3F0] p-4">
      <div className="text-xs font-semibold uppercase tracking-wider text-[#0A5C53]">On</div>
      <div className="font-display text-lg font-semibold">{proposal.title.replace(/\?$/, "")}</div>
      <button type="button" onClick={onRevert} disabled={busy} className="min-h-11 self-start rounded-xl border border-[#A9D8CF] bg-white px-4 text-sm font-medium">Undo</button>
    </section>
  );
}
