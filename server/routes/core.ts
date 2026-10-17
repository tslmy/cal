import type { Express } from "express";
import { DAY_ONE, getUser, listUsers, log, newId, resetUser, update, activity } from "../store";
import { design, systemPrompt } from "../designer";
import { personaOf } from "../profile";
import { mode } from "../llm";
import { promptVersionsUsed, systemFor } from "../prompts";
import { applyOps } from "../../src/shared/ops";
import type { CalendarSpec } from "../../src/shared/catalog";
import type { ChangeSet, Operation, Proposal } from "../../src/shared/types";

// Events, views, proposals: the state every other workstream builds on.
export default function register(app: Express) {
  app.get("/api/users", (_req, res) => res.json(listUsers()));
  app.use(["/api/state/:user", "/api/changes/:user", "/api/design/:user", "/api/proposals/:user"], (req, res, next) =>
    getUser(req.params.user as string) ? next() : res.status(404).json({ error: "no such user" }));

  app.get("/api/state/:user", (req, res) => {
    const s = getUser(req.params.user);
    if (!s) return res.status(404).json({ error: "no such user" });
    res.json({ ...s, mode: mode(), designing: designing.has(s.id) });
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
    const KINDS = { accept: "proposal_accepted", dismiss: "proposal_dismissed", revert: "proposal_reverted" } as const;
    const kind = Object.hasOwn(KINDS, action) ? KINDS[action as keyof typeof KINDS] : undefined;
    if (!kind) return res.status(400).json({ error: "action must be accept, dismiss or revert" });
    // A double click must not accept twice: the second accept would make the undo target the new view.
    const from = { accept: "suggested", dismiss: "suggested", revert: "accepted" }[action as keyof typeof KINDS];
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

const CLASSIC = new Set(["MonthGrid", "WeekGrid"]);
export const isNovel = (spec: CalendarSpec) => Object.values(spec.elements).some((e) => !CLASSIC.has(e.type) && e.type !== "Stack" && e.type !== "Section");

// People the designer is working for right now, so the page can show it's busy.
// Counted, since the gate and "Ask the designer now" can overlap.
const designing = new Map<string, number>();

// Runs the designer for one person and stores the result as a pending proposal.
export async function proposeView(userId: string): Promise<{ proposal: Proposal | null }> {
  designing.set(userId, (designing.get(userId) ?? 0) + 1);
  try {
    return await propose(userId);
  } finally {
    const n = designing.get(userId)! - 1;
    if (n > 0) designing.set(userId, n);
    else designing.delete(userId);
  }
}

async function propose(userId: string): Promise<{ proposal: Proposal | null }> {
  const s = getUser(userId);
  if (!s) throw new Error("no such user");
  const history = s.proposals.filter((p) => p.status !== "suggested").map((p) => ({ title: p.title, status: p.status }));
  const out = await design(personaOf(s), { personaId: s.id, currentSpec: s.spec ?? DAY_ONE, history }, systemFor(systemPrompt(), s, "designer"));
  const proposal: Proposal | null = out.proposal
    ? { ...out.proposal, status: "suggested", at: new Date().toISOString(), novel: isNovel(out.proposal.spec), promptVersions: promptVersionsUsed(s),
        beliefKeys: s.beliefs.filter((b) => b.level === "habit" && b.confidence >= s.settings.threshold).map((b) => b.key) }
    : null;
  const wrote = await update(userId, (st) => {
    for (const t of out.trace) activity(st, t.role, t.text);
    st.proposals = st.proposals.filter((p) => p.status !== "suggested"); // one pending proposal at a time
    if (proposal) st.proposals.push(proposal);
    return true;
  }, s);
  if (!wrote) return { proposal: null }; // started over while the designer worked
  if (proposal) await log(userId, "proposal_shown", { proposalId: proposal.id, title: proposal.title, novel: proposal.novel }, "agent");
  return { proposal };
}
