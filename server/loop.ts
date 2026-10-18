import { activity, DAY_ONE, getUser, listUsers, log, onInteraction, update } from "./store";
import { learn, type LearnResult } from "./agents/habit";
import { design, systemPrompt } from "./designer";
import { personaOf } from "./profile";
import { promptVersionsUsed, systemFor } from "./prompts";
import { isNovel } from "../src/shared/catalog";
import type { InteractionKind, Proposal, UserState } from "../src/shared/types";

// The adaptation loop (E8): the habit learner runs after each interaction (debounced, so a burst
// shares one pass), right after a reaction to a proposal, and on a timer. When a belief newly
// crosses the threshold, the proposal gate (plain code) decides whether to ask the designer.

const DEBOUNCE_MS = 1500;
const TICK_MS = 60_000;
const MUCH_STRONGER = 0.15; // P19: how much a relied-on belief must have grown to re-offer a rejected view
const PROMPT: InteractionKind[] = ["proposal_accepted", "proposal_dismissed", "proposal_reverted", "dwell"];
const SKIP: InteractionKind[] = ["belief_deleted", "settings_changed", "proposal_shown"];

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const chains = new Map<string, Promise<unknown>>();

// Runs one learner pass and the gate, one at a time per person. With `learnedOnly`, the promise
// settles once the learner has finished, while the gate (and any designer run) carries on behind
// it in the same queue, so a replayed week doesn't wait minutes for a suggestion.
export function runLearner(userId: string, label?: string, { learnedOnly = false } = {}): Promise<LearnResult> {
  let learned!: (out: LearnResult) => void;
  const early = new Promise<LearnResult>((r) => (learned = r));
  const next = (chains.get(userId) ?? Promise.resolve()).then(async () => {
    const out = await learn(userId, label);
    learned(out);
    if (out.crossings.length) await gate(userId, out.crossings);
    return out;
  });
  chains.set(userId, next.catch((err) => console.error("[loop]", err)));
  return learnedOnly ? Promise.race([early, next]) : next;
}

function schedule(userId: string, ms: number) {
  clearTimeout(timers.get(userId));
  timers.set(userId, setTimeout(() => runLearner(userId).catch(() => {}), ms));
}

export function startLoop() {
  onInteraction((userId, i) => {
    if (!SKIP.includes(i.kind)) schedule(userId, PROMPT.includes(i.kind) ? 200 : DEBOUNCE_MS);
  });
  // Catches views kept for a while, and anything a pass missed.
  setInterval(() => {
    for (const u of listUsers()) runLearner(u.id).catch(() => {});
  }, TICK_MS).unref();
}

const sameView = (a: Proposal, b: Proposal) => a.title.trim().toLowerCase() === b.title.trim().toLowerCase() || JSON.stringify(a.spec) === JSON.stringify(b.spec);
const confOf = (s: UserState, key: string) => s.beliefs.find((b) => b.key === key)?.confidence ?? 0;

// P19: a view the person dismissed or undid comes back only if a belief it relied on is much stronger now.
function heldBack(s: UserState, p: Proposal): Proposal | undefined {
  return s.proposals.find((q) => q.id !== p.id && (q.status === "dismissed" || q.status === "undone") && sameView(q, p) &&
    !(q.beliefKeys ?? []).some((k) => confOf(s, k) >= (q.beliefConfidence?.[k] ?? s.settings.threshold) + MUCH_STRONGER));
}

async function gate(userId: string, crossed: string[]) {
  const s = getUser(userId);
  if (!s) return;
  const say = (text: string) => update(userId, (st) => activity(st, "Proposal gate", text));
  const names = crossed.map((k) => `"${s.beliefs.find((b) => b.key === k)?.statement ?? k}"`).join(", ");
  if (!s.settings.proposalsOn) return say(`${names} crossed the threshold, but proposals are off.`);
  if (s.proposals.some((p) => p.status === "suggested")) return say(`${names} crossed the threshold; a suggestion is already waiting, so not adding another.`);
  const last = Math.max(0, ...s.proposals.map((p) => (p.at ? new Date(p.at).getTime() : 0)));
  const gap = s.settings.minGapMinutes;
  if (last && Date.now() - last < gap * 60000) return say(`${names} crossed the threshold; the last suggestion was ${Math.round((Date.now() - last) / 60000)} min ago, under the ${gap}-minute gap.`);
  if (!s.events.length) return;

  await say(`${names} crossed the ${s.settings.threshold.toFixed(2)} threshold. Asking the designer for one change.`);
  const { proposal } = await proposeView(userId);
  if (!proposal) return;
  await update(userId, (st) => {
    const p = st.proposals.find((x) => x.id === proposal.id);
    if (!p) return;
    const old = heldBack(st, p);
    if (old) {
      st.proposals = st.proposals.filter((x) => x.id !== p.id);
      activity(st, "Proposal gate", `Held back "${p.title}": you ${old.status === "undone" ? "undid" : "dismissed"} it before, and the habits behind it are not much stronger now.`);
      return;
    }
    p.beliefConfidence = Object.fromEntries((p.beliefKeys ?? []).map((k) => [k, confOf(st, k)]));
  });
}

// People the designer is working for right now, so the page can show it's busy.
// Counted, since the gate and "Ask the designer now" can overlap.
const designing = new Map<string, number>();
export const isDesigning = (userId: string) => designing.has(userId);

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
