import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, useAction } from "../api";
import { ChangePreview } from "./ChangePreview";
import { addDays, daysBetween, mondayOf } from "../shared/dates";
import { PRECISIONS } from "../shared/when";
import type { ChangeSet, EventDraft, Precision } from "../shared/types";

// Natural-language event CRUD (P1 to P3): one sentence in, a previewed ChangeSet out.
// A single new event shows as editable chips; anything else shows as a diff.

const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// Keeps the draft consistent when one chip changes: length is preserved, precision decides the shape.
function setPrecision(e: EventDraft, p: Precision): EventDraft {
  const d = e.start.slice(0, 10);
  if (p === "exact" || p === "approximate") return e.start.length > 10 ? { ...e, precision: p } : { ...e, precision: p, start: `${d}T12:00`, end: `${d}T13:00` };
  if (p === "day") return { ...e, precision: p, start: d, end: d };
  if (p === "week") return { ...e, precision: p, start: mondayOf(d), end: addDays(mondayOf(d), 6) };
  return { ...e, precision: p, start: d, end: e.end.slice(0, 10) };
}
function setDate(e: EventDraft, d: string): EventDraft {
  if (!d) return e;
  const span = daysBetween(e.start.slice(0, 10), e.end.slice(0, 10));
  return { ...e, start: d + e.start.slice(10), end: addDays(d, span) + e.end.slice(10) };
}
function setTime(e: EventDraft, t: string): EventDraft {
  if (!t) return e;
  const len = daysBetween(e.start.slice(0, 10), e.end.slice(0, 10)) * 1440 + minutes(e.end.slice(11)) - minutes(e.start.slice(11));
  const end = minutes(t) + len;
  return { ...e, start: `${e.start.slice(0, 10)}T${t}`, end: `${addDays(e.start.slice(0, 10), Math.floor(end / 1440))}T${hhmm(end % 1440)}` };
}

const chip = "min-h-9 rounded-full border border-line-strong bg-white px-3 text-sm focus:border-ink focus:outline-none";

function DraftChips({ draft, onChange }: { draft: EventDraft; onChange: (e: EventDraft) => void }) {
  const timed = draft.start.length > 10;
  const ranged = draft.precision === "span" || draft.precision === "week";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="draft-title">Title</label>
      <input id="draft-title" autoFocus value={draft.title} onChange={(e) => onChange({ ...draft, title: e.target.value })} className={`${chip} min-w-48 flex-1 font-medium`} />
      <label className="sr-only" htmlFor="draft-date">{ranged ? "From" : "Date"}</label>
      <input id="draft-date" type="date" value={draft.start.slice(0, 10)} onChange={(e) => onChange(setDate(draft, e.target.value))} className={chip} />
      {ranged && (
        <>
          <span className="text-sm text-muted">to</span>
          <label className="sr-only" htmlFor="draft-end">To</label>
          <input id="draft-end" type="date" min={draft.start.slice(0, 10)} value={draft.end.slice(0, 10)} onChange={(e) => e.target.value && onChange({ ...draft, end: e.target.value })} className={chip} />
        </>
      )}
      {timed && (
        <>
          <label className="sr-only" htmlFor="draft-time">Time</label>
          <input id="draft-time" type="time" value={draft.start.slice(11, 16)} onChange={(e) => onChange(setTime(draft, e.target.value))} className={chip} />
        </>
      )}
      <label className="sr-only" htmlFor="draft-precision">Precision</label>
      <select id="draft-precision" value={draft.precision ?? "exact"} onChange={(e) => onChange(setPrecision(draft, e.target.value as Precision))} className={chip}>
        {PRECISIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
      </select>
      <span className="rounded-full bg-subtle px-3 py-1.5 text-xs text-muted">{draft.category}</span>
    </div>
  );
}

export function CommandBar({ user }: { user: string }) {
  const [text, setText] = useState("");
  // Tagged with the user it was parsed for, so switching users drops it.
  const [pending, setPending] = useState<{ user: string; cs: ChangeSet } | null>(null);
  const cs = pending?.user === user ? pending.cs : null;
  const setCs = (c: ChangeSet | null) => setPending(c && { user, cs: c });
  const input = useRef<HTMLInputElement>(null);
  const parse = useAction(user, (t: string) => api<ChangeSet>(`/api/intent/${user}`, { text: t, source: "typed" }));
  const apply = useAction(user, (c: ChangeSet) => api(`/api/changes/${user}/apply`, c));
  const undo = useAction(user, (id: string) => api(`/api/changes/${user}/undo`, { changeSetId: id }));

  // "/" jumps to the sentence box from anywhere that isn't a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const close = () => {
    setCs(null);
    input.current?.focus();
  };
  const submit = () => {
    if (!text.trim() || parse.isPending) return;
    parse.mutate(text, { onSuccess: setCs, onError: (err) => toast.error(err.message) });
  };
  const confirm = (c: ChangeSet) =>
    apply.mutate(c, {
      onSuccess: () => {
        setText("");
        close();
        toast.success(c.summary, { action: { label: "Undo", onClick: () => undo.mutate(c.id, { onSuccess: () => toast("Undone"), onError: (err) => toast.error(err.message) }) } });
      },
      onError: (err) => toast.error(err.message),
    });

  const single = cs?.ops.length === 1 && cs.ops[0].op === "create" ? cs.ops[0].event : null;

  return (
    <div className="flex flex-col gap-2">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex gap-2">
        <label htmlFor="command" className="sr-only">Add, change or ask about events</label>
        <input
          id="command"
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (cs ? close() : setText(""))}
          placeholder={'Try "lunch with Ana Thursday around noon" or "empty out my weekend for a business trip"   ( / )'}
          autoComplete="off"
          className="min-h-11 min-w-0 flex-1 rounded-xl border border-line-strong bg-white px-4 focus:border-ink focus:outline-none"
        />
        <button type="submit" disabled={parse.isPending || !text.trim()} className="min-h-11 shrink-0 rounded-xl bg-ink px-4 font-semibold text-white disabled:opacity-60">
          {parse.isPending ? "Reading..." : "Go"}
        </button>
      </form>

      {cs && single && (
        <form
          aria-label="New event"
          onSubmit={(e) => { e.preventDefault(); confirm(cs); }}
          onKeyDown={(e) => e.key === "Escape" && close()}
          className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-4 shadow-sm"
        >
          <DraftChips draft={single} onChange={(event) => setCs({ ...cs, ops: [{ op: "create", event }], summary: `Add "${event.title}"` })} />
          <div className="flex gap-2">
            <button type="submit" disabled={apply.isPending || !single.title.trim()} className="min-h-11 rounded-xl bg-ink px-4 font-semibold text-white disabled:opacity-60">{apply.isPending ? "Saving..." : "Save"}</button>
            <button type="button" onClick={close} className="min-h-11 rounded-xl border border-line-strong px-4">Cancel</button>
          </div>
        </form>
      )}
      {cs && !single && <ChangePreview changeSet={cs} busy={apply.isPending} onConfirm={() => confirm(cs)} onCancel={close} />}
    </div>
  );
}
