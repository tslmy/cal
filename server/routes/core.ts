import type { Express } from "express";
import { getUser, listUsers, log, newId, resetUser, update, activity } from "../store";
import { isDesigning, proposeView } from "../loop";
import { mode } from "../llm";
import { applyOps } from "../../src/shared/ops";
import type { CalendarSpec } from "../../src/shared/catalog";
import type { ChangeSet, Operation } from "../../src/shared/types";

// Each reaction to a proposal: what it logs, and the status it applies to. A double click must not
// accept twice: the second accept would make the undo target the new view.
const REACTIONS = {
  accept: { kind: "proposal_accepted", from: "suggested" },
  dismiss: { kind: "proposal_dismissed", from: "suggested" },
  revert: { kind: "proposal_reverted", from: "accepted" },
} as const;

// Events, views, proposals: the state every other workstream builds on.
export default function register(app: Express) {
  app.get("/api/users", (_req, res) => res.json(listUsers()));

  app.get("/api/state/:user", (req, res) => {
    const s = getUser(req.params.user)!;
    res.json({ ...s, mode: mode(), designing: isDesigning(s.id) });
  });

  app.post("/api/state/:user/reset", async (req, res) => {
    await resetUser(req.params.user, req.body?.blank === true);
    res.json(getUser(req.params.user));
  });

  // Manual view switch from the button group (P13).
  app.post("/api/state/:user/view", async (req, res) => {
    const spec = req.body?.spec as CalendarSpec;
    if (!spec?.root || !spec.elements?.[spec.root]) return res.status(400).json({ error: "spec is required" });
    const from = getUser(req.params.user)?.spec;
    await update(req.params.user, (s) => (s.spec = spec));
    await log(req.params.user, "view_switch", { from, to: spec, label: req.body?.label }, "manual");
    res.json(getUser(req.params.user));
  });

  // Apply a previewed change set (P3, E12). The inverse is kept for one-tap undo.
  app.post("/api/changes/:user/apply", async (req, res) => {
    const cs = req.body as ChangeSet;
    if (!Array.isArray(cs?.ops) || !cs.ops.every((o) => ["create", "update", "delete"].includes(o?.op))) return res.status(400).json({ error: "ops must be a list of create, update or delete" });
    await update(req.params.user, (s) => {
      const { events, inverse } = applyOps(s.events, cs.ops, () => newId("e"));
      s.events = events;
      s.undo.push({ changeSetId: cs.id, ops: inverse });
      activity(s, "Calendar", `Applied: ${cs.summary}`);
    });
    for (const o of cs.ops) await log(req.params.user, o.op, { changeSetId: cs.id, op: o }, cs.source);
    res.json(getUser(req.params.user));
  });

  app.post("/api/changes/:user/undo", async (req, res) => {
    const id = req.body?.changeSetId as string | undefined;
    const done = await update(req.params.user, (s) => {
      const i = id ? s.undo.findIndex((u) => u.changeSetId === id) : s.undo.length - 1;
      if (i < 0) return null;
      const [entry] = s.undo.splice(i, 1);
      s.events = applyOps(s.events, entry.ops, () => newId("e")).events;
      activity(s, "Calendar", "Undid the last change.");
      return entry;
    });
    if (!done) return res.status(404).json({ error: "nothing to undo" });
    for (const o of done.ops) await log(req.params.user, o.op, { undoOf: done.changeSetId, op: o as Operation }, "manual");
    res.json(getUser(req.params.user));
  });

  // Ask the designer for a proposal now. The learning loop also calls proposeView() itself.
  app.post("/api/design/:user", async (req, res) => {
    try {
      res.json(await proposeView(req.params.user));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Reactions to a proposal (P10).
  app.post("/api/proposals/:user/:id/:action", async (req, res) => {
    const { user, id, action } = req.params;
    const reaction = Object.hasOwn(REACTIONS, action) ? REACTIONS[action as keyof typeof REACTIONS] : undefined;
    if (!reaction) return res.status(400).json({ error: "action must be accept, dismiss or revert" });
    const { kind, from } = reaction;
    const p = await update(user, (s) => {
      const p = s.proposals.find((x) => x.id === id);
      if (!p) return null;
      if (p.status !== from) return "stale" as const;
      if (action === "accept") {
        p.previous = s.spec;
        s.spec = p.spec;
        p.status = "accepted";
      } else if (action === "dismiss") {
        p.status = "dismissed";
      } else {
        if (p.previous) s.spec = p.previous;
        p.status = "undone";
      }
      return p;
    });
    if (!p) return res.status(404).json({ error: "no such proposal" });
    if (p === "stale") return res.json(getUser(user)); // already handled
    await log(user, kind, { proposalId: id, title: p.title, beliefKeys: p.beliefKeys, novel: p.novel, promptVersions: p.promptVersions, shownAt: p.at }, "manual");
    res.json(getUser(user));
  });
}
