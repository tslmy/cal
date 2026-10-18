import type { Express, Response } from "express";
import { getUser, log, newId, update, activity } from "../store";
import { dedupe, parseEmail, parseIcs, HOME_ZONE } from "../agents/importer";
import { plural } from "../../src/shared/when";
import type { ChangeSet, EventDraft, Source, UserState } from "../../src/shared/types";

// .ics and email imports (P4, P6, P7). Both answer with a ChangeSet of creates for the preview;
// applying it goes through /api/changes/:user/apply like every other change.

function changeSet(drafts: EventDraft[], state: UserState, source: Source, from: string): { cs: ChangeSet; dupes: number } {
  const { fresh, dupes } = dedupe(drafts, state);
  const summary = !drafts.length
    ? `No events found in ${from}`
    : !fresh.length
      ? `Nothing new: all ${plural(drafts.length, "event")} ${drafts.length === 1 ? "is" : "are"} already in your calendar`
      : `Import ${plural(fresh.length, "event")} from ${from}${dupes ? ` (${dupes} already in your calendar)` : ""}`;
  return { cs: { id: newId("cs"), summary, source, ops: fresh.map((event) => ({ op: "create", event })) }, dupes };
}

const fail = (res: Response, err: unknown) => res.status(400).json({ error: `Could not read that file: ${(err as Error).message}` });

export default function register(app: Express) {
  app.post("/api/import/:user/ics", async (req, res) => {
    const { user } = req.params;
    const state = getUser(user)!;
    const text = req.body?.text as string | undefined;
    const name = (req.body?.name as string | undefined) ?? "calendar file";
    if (!text?.includes("BEGIN:VCALENDAR")) return res.status(400).json({ error: "That is not an .ics calendar file." });
    let parsed;
    try {
      parsed = parseIcs(text);
    } catch (err) {
      return fail(res, err);
    }
    const { cs, dupes } = changeSet(parsed.drafts, state, "ics", name);
    await update(user, (s) =>
      activity(s, "Importer", `Read ${name}: ${plural(parsed.series, "event")} (${parsed.recurring} recurring) expanded to ${plural(parsed.drafts.length, "occurrence")} in ${HOME_ZONE} time; ${cs.ops.length} new, ${dupes} already there.`));
    await log(user, "import", { file: name, changeSetId: cs.id, series: parsed.series, recurring: parsed.recurring, found: parsed.drafts.length, new: cs.ops.length, duplicates: dupes }, "ics");
    res.json(cs);
  });

  app.post("/api/import/:user/email", async (req, res) => {
    const { user } = req.params;
    const state = getUser(user)!;
    const files = (req.body?.files ?? []) as { name: string; text: string }[];
    if (!files.length) return res.status(400).json({ error: "files are required" });
    let results;
    try {
      results = await Promise.all(files.map((f) => parseEmail(f.name, f.text, state)));
    } catch (err) {
      return fail(res, err);
    }
    const from = files.length === 1 ? `"${results[0].subject}"` : plural(files.length, "email");
    const { cs, dupes } = changeSet(results.flatMap((r) => r.drafts), state, "email", from);
    await update(user, (s) => {
      for (const r of results)
        activity(s, "Importer", `Email "${r.subject}": ${r.drafts.length ? r.drafts.map((d) => `${d.title} (${d.start})`).join(", ") : "no events"} via ${r.via === "ics" ? "its calendar invite" : r.via === "model" ? "Nemotron" : "date parsing"}.${r.error ? ` Model failed, used date parsing: ${r.error}` : ""}`);
    });
    await log(user, "import", { files: files.map((f) => f.name), changeSetId: cs.id, found: results.reduce((n, r) => n + r.drafts.length, 0), new: cs.ops.length, duplicates: dupes, via: results.map((r) => r.via) }, "email");
    res.json(cs);
  });
}
