import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { api, useAction, useUserState, type ServerState } from "../api";
import { ChangePreview } from "./ChangePreview";
import { addDays, daysBetween, mondayOf } from "../shared/dates";
import { PRECISIONS } from "../shared/when";
import type { ChangeSet, EventDraft, Precision } from "../shared/types";

// Natural-language event CRUD (P1 to P3): one sentence in, a previewed ChangeSet out.
// A single new event shows as editable chips; anything else shows as a diff.
// Sent sentences stay above the box as chat bubbles. A replay (started from the developer tools)
// types a request file into the box line by line and applies each result, to show a
// fast-forwarded person using the calendar.

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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Each sent request carries a reaction, like a messenger app: a spinner while the intent agent reads
// it, a check once it has, a pen once the habit learner has read the change it made into the log.
type Sent = { id: number; user: string; text: string; status: "reading" | "read" | "failed" | "stopped"; through?: number };

function Reaction({ line, learnedThrough }: { line: Sent; learnedThrough: number }) {
  const learned = line.status === "read" && line.through !== undefined && learnedThrough >= line.through;
  const label = { reading: "Reading", failed: "Couldn't read this", stopped: "Stopped before this was applied", read: learned ? "Read and learned from" : "Read" }[line.status];
  return (
    <span role="img" aria-label={label} title={label}
      className="absolute -bottom-2.5 -left-2.5 flex size-6 items-center justify-center rounded-full border border-line bg-white text-xs shadow-sm">
      {line.status === "reading" ? <span aria-hidden className="size-3 animate-spin rounded-full border-2 border-line-strong border-t-[#0B84FE]" /> : line.status === "failed" ? "⚠️" : line.status === "stopped" ? "⏹️" : learned ? "📝" : "✅"}
    </span>
  );
}

function ChatLog({ lines, learnedThrough, onClear }: { lines: Sent[]; learnedThrough: number; onClear: () => void }) {
  const end = useRef<HTMLLIElement>(null);
  // Braces matter: newer browsers return a Promise from scrollIntoView, and React would treat it as a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [lines.length]);
  return (
    <div className="relative">
      <ol aria-label="Sent requests" className="m-0 flex h-36 list-none flex-col gap-3.5 overflow-y-auto p-0 pb-2.5 pr-1">
        {!lines.length && <li className="m-auto text-sm text-faint">Requests you send show up here</li>}
        <AnimatePresence initial={false}>
          {lines.map((l) => (
            <motion.li key={l.id} layout initial={{ opacity: 0, y: 12, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }}
              className="relative max-w-[75%] self-end rounded-2xl rounded-br-md bg-[#0B84FE] px-3.5 py-2 text-[15px] leading-snug text-white first:mt-auto">
              {l.text}
              <Reaction line={l} learnedThrough={learnedThrough} />
            </motion.li>
          ))}
        </AnimatePresence>
        <li ref={end} aria-hidden />
      </ol>
      {lines.length > 0 && <button type="button" onClick={onClear} className="absolute left-0 top-0 text-xs text-muted hover:text-ink">Clear</button>}
    </div>
  );
}

// `apply`, when given, replaces parsing: the time scrub sends its own requests and applies each
// simulated week itself once its last line is sent.
// It resolves to the person's state when it applied something, so the lines sent so far are marked read.
let started = 0; // the last replay id this page has run, kept outside the component on purpose

export type Replay = { id: number; lines: string[]; apply?: (i: number) => Promise<ServerState | undefined>; fresh?: boolean };

export function CommandBar({ user, replay: request, onProgress, stop, onStop, children }: {
  user: string; replay: Replay | null; onProgress: (p: { at: number; of: number } | null) => void; stop: React.RefObject<boolean>; onStop: () => void; children?: React.ReactNode;
}) {
  const [text, setText] = useState("");
  // Tagged with the user it was parsed for, so switching users drops it.
  const [pending, setPending] = useState<{ user: string; cs: ChangeSet } | null>(null);
  const cs = pending?.user === user ? pending.cs : null;
  const setCs = (c: ChangeSet | null) => setPending(c && { user, cs: c });
  const [sent, setSent] = useState<Sent[]>([]);
  const nextId = useRef(0);
  const say = (t: string) => {
    const id = nextId.current++;
    setSent((s) => [...s, { id, user, text: t.trim(), status: "reading" }]);
    return id;
  };
  const mark = (ids: number[] | ((l: Sent) => boolean), patch: Partial<Sent>) =>
    setSent((s) => s.map((l) => ((typeof ids === "function" ? ids(l) : ids.includes(l.id)) ? { ...l, ...patch } : l)));
  // Where the change a request made ends in the log; the learner has read it once it gets this far.
  const through = (s: ServerState) => ({ through: s.interactions.length });
  const learnedThrough = useUserState(user).data?.learnedThrough ?? 0;
  const [asked, setAsked] = useState<number | null>(null); // the request behind the preview on screen
  const [replay, setReplay] = useState<{ at: number; of: number; stopping?: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const parse = useAction(user, (t: string) => api<ChangeSet>(`/api/intent/${user}`, { text: t, source: "typed" }), { quiet: true });
  const apply = useAction(user, (c: ChangeSet) => api(`/api/changes/${user}/apply`, c), { quiet: true });
  const undo = useAction(user, (id: string) => api(`/api/changes/${user}/undo`, { changeSetId: id }), { quiet: true });

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
  // Switching people stops a replay meant for someone else.
  useEffect(() => () => void (stop.current = true), [user, stop]);

  const close = () => {
    setCs(null);
    input.current?.focus();
  };
  const submit = () => {
    if (!text.trim() || parse.isPending || replay) return;
    const id = say(text);
    setAsked(id);
    parse.mutate(text, {
      onSuccess: (c) => { setText(""); setCs(c); mark([id], { status: "read" }); },
      onError: (err) => { mark([id], { status: "failed" }); toast.error(err.message); },
    });
  };
  const confirm = (c: ChangeSet) =>
    apply.mutate(c, {
      onSuccess: (s) => {
        if (asked !== null) mark([asked], through(s));
        close();
        toast.success(c.summary, { action: { label: "Undo", onClick: () => undo.mutate(c.id, { onSuccess: () => toast("Undone"), onError: (err) => toast.error(err.message) }) } });
      },
      onError: (err) => toast.error(err.message),
    });

  // Types each line into the box, sends it as a bubble and applies what it parses to, unreviewed.
  const play = async ({ lines, apply: applyLine, fresh }: Replay) => {
    stop.current = false;
    if (fresh) setSent((all) => all.filter((l) => l.user !== user)); // the person was started over
    setCs(null);
    let failed = 0;
    // Stop shouldn't wait for a slow model call or a learner pass: the replay lets go of the request
    // in flight (the server may still finish it) and ends right away.
    const STOPPED = new Error("stopped");
    const orStop = <T,>(work: Promise<T>) =>
      new Promise<T>((resolve, reject) => {
        let done = false;
        work.then((v) => { done = true; resolve(v); }, (e) => { done = true; reject(e); });
        void (async () => {
          while (!done && !stop.current) await wait(100);
          if (!done) reject(STOPPED);
        })();
      });
    for (const [i, line] of lines.entries()) {
      if (stop.current) break;
      setReplay({ at: i + 1, of: lines.length });
      onProgress({ at: i + 1, of: lines.length });
      const step = Math.min(applyLine ? 8 : 18, (applyLine ? 400 : 900) / line.length);
      for (let n = 1; n <= line.length && !stop.current; n++) {
        setText(line.slice(0, n));
        await wait(step);
      }
      if (stop.current) break;
      await wait(150);
      setText("");
      const id = say(line);
      try {
        if (applyLine) {
          // The request's events land before the next request is typed.
          const s = await orStop(applyLine(i));
          if (s) mark((l) => l.user === user && l.status === "reading", { status: "read", ...through(s) });
        } else {
          const c = await orStop(parse.mutateAsync(line));
          mark([id], { status: "read" });
          if (c.ops.length) mark([id], through(await orStop(apply.mutateAsync(c))));
        }
      } catch (err) {
        if (err === STOPPED) break;
        mark([id], { status: "failed" });
        failed++;
      }
      await wait(250);
    }
    mark((l) => l.user === user && l.status === "reading", { status: "stopped" }); // a stopped scrub's unapplied week
    setReplay(null);
    onProgress(null);
    setText("");
    if (failed) toast.error(`${failed} of ${lines.length} requests could not be applied`);
  };

  useEffect(() => {
    // Switching people remounts the bar; a replay that already ran must not start again for them.
    if (!request || request.id <= started) return;
    started = request.id;
    void play(request);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per replay request
  }, [request?.id]);

  const single = cs?.ops.length === 1 && cs.ops[0].op === "create" ? cs.ops[0].event : null;
  const busy = parse.isPending || !!replay;

  return (
    <div className="flex flex-col gap-2">
      {cs && (
        <div className="max-h-[50vh] overflow-auto">
          {single ? (
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
          ) : (
            <ChangePreview changeSet={cs} busy={apply.isPending} onConfirm={() => confirm(cs)} onCancel={close} />
          )}
        </div>
      )}

      <ChatLog lines={sent.filter((l) => l.user === user)} learnedThrough={learnedThrough} onClear={() => setSent((s) => s.filter((l) => l.user !== user))} />

      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex min-w-0 flex-[1_1_420px] gap-2">
          <label htmlFor="command" className="sr-only">Add, change or ask about events</label>
          <input
            id="command"
            ref={input}
            value={text}
            readOnly={!!replay}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (cs ? close() : setText(""))}
            placeholder={'Try "lunch with Ana Thursday around noon" or "empty out my weekend for a business trip"   ( / )'}
            autoComplete="off"
            className="min-h-11 min-w-0 flex-1 rounded-full border border-line-strong bg-white px-4 focus:border-ink focus:outline-none"
          />
          {replay ? (
            <button type="button" disabled={replay.stopping} onClick={() => { onStop(); setReplay((r) => r && { ...r, stopping: true }); }} className="min-h-11 shrink-0 rounded-full border border-line-strong bg-white px-4 font-semibold disabled:opacity-60">
              {replay.stopping ? "Stopping..." : `Stop (${replay.at} of ${replay.of})`}
            </button>
          ) : (
            <button type="submit" disabled={busy || !text.trim()} className="min-h-11 shrink-0 rounded-full bg-[#0B84FE] px-4 font-semibold text-white disabled:opacity-60">
              {parse.isPending ? "Reading..." : "Send"}
            </button>
          )}
        </form>
        {children}
      </div>
    </div>
  );
}
