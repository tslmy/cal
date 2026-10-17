import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, useAction } from "../api";
import { ChangePreview } from "./ChangePreview";
import type { ChangeSet } from "../shared/types";

// .ics, free-form text and email imports (P4 to P7). Every import is previewed as a ChangeSet,
// applied through /api/changes and can be undone from the toast.

type Kind = "ics" | "text" | "email";
const KINDS: { kind: Kind; label: string; hint: string; accept: string; multiple?: boolean }[] = [
  { kind: "ics", label: "Calendar file", hint: ".ics from Google, Outlook or Apple", accept: ".ics,text/calendar" },
  { kind: "text", label: "Text file", hint: "Notes or a plan; can also move or clear events", accept: ".txt,.md,text/plain" },
  { kind: "email", label: "Emails", hint: ".eml bookings, invites, confirmations", accept: ".eml,message/rfc822", multiple: true },
];

const read = (files: File[]) => Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })));

function parse(user: string, kind: Kind, files: { name: string; text: string }[]): Promise<ChangeSet> {
  if (kind === "ics") return api<ChangeSet>(`/api/import/${user}/ics`, files[0]);
  if (kind === "email") return api<ChangeSet>(`/api/import/${user}/email`, { files });
  return api<ChangeSet>(`/api/intent/${user}`, { text: files[0].text, source: "text" });
}

export function ImportMenu({ user }: { user: string }) {
  const [open, setOpen] = useState(false);
  // Keyed by person so switching users drops a preview made for someone else.
  const [pending, setPending] = useState<{ user: string; cs: ChangeSet } | null>(null);
  const preview = pending?.user === user ? pending.cs : null;
  const setPreview = (cs: ChangeSet | null) => setPending(cs && { user, cs });
  const [reading, setReading] = useState<string | null>(null);
  const inputs = useRef<Partial<Record<Kind, HTMLInputElement | null>>>({});
  const root = useRef<HTMLDivElement>(null);
  const apply = useAction(user, (cs: ChangeSet) => api(`/api/changes/${user}/apply`, cs), { quiet: true });
  const undo = useAction(user, (changeSetId: string) => api(`/api/changes/${user}/undo`, { changeSetId }), { quiet: true });

  useEffect(() => {
    if (!open && !preview) return;
    const close = (e: KeyboardEvent | MouseEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) {
        setOpen(false);
        if (e instanceof KeyboardEvent) setPending(null);
      }
    };
    document.addEventListener("keydown", close);
    document.addEventListener("mousedown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("mousedown", close);
    };
  }, [open, preview]);

  const pick = (k: Kind) => {
    setOpen(false);
    inputs.current[k]?.click(); // inside the click handler, so the browser allows the file dialog
  };

  const onFiles = async (kind: Kind, el: HTMLInputElement) => {
    const files = [...(el.files ?? [])];
    el.value = ""; // so picking the same file again still fires change
    if (!files.length) return;
    setPreview(null);
    setReading(files.length === 1 ? files[0].name : `${files.length} files`);
    try {
      setPreview(await parse(user, kind, await read(files)));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setReading(null);
    }
  };

  const confirm = (cs: ChangeSet) =>
    apply.mutate(cs, {
      onSuccess: () => {
        setPreview(null);
        toast.success(cs.summary.replace(/^Import/, "Imported"), { action: { label: "Undo", onClick: () => undo.mutate(cs.id, { onError: (e) => toast.error(e.message) }) } });
      },
      onError: (e) => toast.error(e.message),
    });

  return (
    <div ref={root} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} disabled={!!reading} onClick={() => setOpen((o) => !o)}
        className="min-h-11 rounded-xl border border-line-strong bg-white px-4 text-sm font-semibold disabled:text-muted">
        {reading ? `Reading ${reading}…` : "Import"}
      </button>
      {KINDS.map((k) => (
        <input key={k.kind} ref={(el) => void (inputs.current[k.kind] = el)} type="file" hidden accept={k.accept} multiple={k.multiple} onChange={(e) => onFiles(k.kind, e.target)} />
      ))}
      {open && (
        <div role="menu" className="absolute bottom-full right-0 z-30 mb-2 flex w-72 flex-col rounded-xl border border-line bg-white p-1 shadow-lg">
          {KINDS.map((k) => (
            <button key={k.kind} type="button" role="menuitem" onClick={() => pick(k.kind)} className="flex flex-col rounded-lg px-3 py-2 text-left hover:bg-subtle">
              <span className="text-sm font-semibold">{k.label}</span>
              <span className="text-xs text-muted">{k.hint}</span>
            </button>
          ))}
        </div>
      )}
      {preview && (
        <div className="absolute bottom-full right-0 z-30 mb-2 max-h-[60vh] w-[min(28rem,calc(100vw-2rem))] overflow-auto rounded-2xl shadow-lg">
          <ChangePreview changeSet={preview} busy={apply.isPending} onConfirm={() => confirm(preview)} onCancel={() => setPreview(null)} />
        </div>
      )}
    </div>
  );
}
