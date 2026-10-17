import { z } from "zod";
import { createTwoFilesPatch } from "diff";
import { activity, DAY_ONE, getUser, listUsers, log, onInteraction, update } from "../store";
import { isLive, structured } from "../llm";
import { activePrompt, learnedSection, systemFor, withLearned } from "../prompts";
import { design, systemPrompt } from "../designer";
import { personaOf } from "../profile";
import { isNovel } from "../routes/core";
import { PERSONAS } from "../../src/shared/personas";
import type { AgentName, Belief, Interaction, PromptVersion, Proposal, UserState } from "../../src/shared/types";

// Meta-learner (E3 to E7): learns how the person wants to be adapted to, moves the proposal
// threshold and gap, and rewrites every agent's learned prompt section, its own included.
// A rewrite is replayed against this person and the sample personas before it is adopted.

const ROLE = "Meta-learner";
const AGENTS: AgentName[] = ["designer", "intent", "importer", "habit", "meta"];
const OUTCOMES = new Set(["proposal_accepted", "proposal_dismissed", "proposal_reverted"]);
const QUICK_REVERT_MS = 10 * 60_000;
const REVERTS_TO_ROLL_BACK = 2;

const Level = z.enum(["low", "medium", "high"]);
const Meta = z.object({
  novelty_appetite: z.number().min(0).max(1),
  density: Level,
  cadence: z.enum(["fewer", "same", "more"]),
  change_size: z.enum(["small", "medium", "large"]),
  explanation: z.enum(["brief", "normal", "detailed"]),
  reason: z.string(),
});
type MetaPrefs = z.infer<typeof Meta>;
const Sections = z.object(Object.fromEntries(AGENTS.map((a) => [a, z.string().min(1).max(900)])) as Record<AgentName, z.ZodString>);

const META_CORE = [
  "You are the meta-learner of Evolve, a calendar app whose layout adapts to each person.",
  "You do not learn habits. You learn how this person wants to be adapted to: how much novelty they like, how dense views should be, how often to suggest, how big each step may be, and how much explanation they read.",
  "You read counts of their reactions to past suggestions and output JSON only.",
].join("\n");

// ---------- E4: signals from reactions ----------

type Signals = {
  novelKept: number; novelQuickReverts: number; novelSlowReverts: number; novelDismissed: number;
  classicKept: number; classicReverts: number; classicDismissed: number;
  backToClassic: number; dismissStreak: number; bigReverts: number; bigKept: number;
  replacedReverts: number; replacedKept: number; medianReactSec: number | null;
  evidence: Record<keyof Omit<MetaPrefs, "reason">, string[]>;
};

type Spec = UserState["spec"] | undefined;
const backToClassic = (i: Interaction) => {
  const from = i.payload.from as Spec;
  const to = i.payload.to as Spec;
  return i.kind === "view_switch" && !!from?.elements && !!to?.elements && isNovel(from) && !isNovel(to);
};

const size = (p?: Proposal) => (p ? Object.keys(p.spec.elements).length : 0);
const replaces = (p?: Proposal) => !!p?.previous && !Object.values(p.spec.elements).some((e) => Object.values(p.previous!.elements).some((x) => x.type === e.type && e.type !== "Stack" && e.type !== "Section"));

function signals(s: UserState): Signals {
  const byId = new Map(s.proposals.map((p) => [p.id, p]));
  const out: Signals = {
    novelKept: 0, novelQuickReverts: 0, novelSlowReverts: 0, novelDismissed: 0, classicKept: 0, classicReverts: 0, classicDismissed: 0,
    backToClassic: 0, dismissStreak: 0, bigReverts: 0, bigKept: 0, replacedReverts: 0, replacedKept: 0, medianReactSec: null,
    evidence: { novelty_appetite: [], density: [], cadence: [], change_size: [], explanation: [] },
  };
  const acceptedAt = new Map<string, number>();
  const reacts: number[] = [];
  for (const i of s.interactions) {
    const id = String(i.payload.proposalId ?? "");
    const p = byId.get(id);
    const novel = !!i.payload.novel;
    const at = Date.parse(i.at);
    if (backToClassic(i)) {
      out.backToClassic++;
      out.evidence.novelty_appetite.push(i.id);
    }
    if (!OUTCOMES.has(i.kind)) continue;
    if (i.kind !== "proposal_reverted" && typeof i.payload.shownAt === "string") {
      reacts.push((at - Date.parse(i.payload.shownAt)) / 1000);
      out.evidence.explanation.push(i.id);
    }
    if (i.kind === "proposal_accepted") {
      acceptedAt.set(id, at);
      out.dismissStreak = 0;
    } else if (i.kind === "proposal_dismissed") {
      out.dismissStreak++;
      if (novel) out.novelDismissed++;
      else out.classicDismissed++;
      out.evidence.cadence.push(i.id);
      out.evidence.novelty_appetite.push(i.id);
    } else {
      const quick = at - (acceptedAt.get(id) ?? 0) < QUICK_REVERT_MS;
      if (!novel) out.classicReverts++;
      else if (quick) out.novelQuickReverts++;
      else out.novelSlowReverts++;
      if (size(p) > 3) out.bigReverts++;
      if (replaces(p)) out.replacedReverts++;
      for (const k of ["novelty_appetite", "density", "change_size", "cadence"] as const) out.evidence[k].push(i.id);
    }
  }
  for (const p of s.proposals.filter((p) => p.status === "accepted")) {
    if (p.novel) out.novelKept++;
    else out.classicKept++;
    if (size(p) > 3) out.bigKept++;
    if (replaces(p)) out.replacedKept++;
  }
  if (reacts.length) out.medianReactSec = [...reacts].sort((a, b) => a - b)[Math.floor(reacts.length / 2)];
  return out;
}

// ---------- E3: deterministic rules (mock mode, and the fallback in live mode) ----------

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

function rules(g: Signals): MetaPrefs {
  const novelty = round2(clamp(0.5 + 0.12 * g.novelKept - 0.15 * g.novelQuickReverts - 0.1 * g.novelSlowReverts - 0.08 * g.novelDismissed - 0.1 * g.backToClassic, 0, 1));
  const why: string[] = [];
  if (g.novelQuickReverts) why.push(`${g.novelQuickReverts} invented view${g.novelQuickReverts > 1 ? "s" : ""} reverted within minutes`);
  if (g.novelSlowReverts) why.push(`${g.novelSlowReverts} invented view${g.novelSlowReverts > 1 ? "s" : ""} reverted later`);
  if (g.novelDismissed) why.push(`${g.novelDismissed} invented view${g.novelDismissed > 1 ? "s" : ""} dismissed`);
  if (g.backToClassic) why.push(`${g.backToClassic} manual switch${g.backToClassic > 1 ? "es" : ""} back to a classic view`);
  if (g.novelKept) why.push(`${g.novelKept} invented view${g.novelKept > 1 ? "s" : ""} kept`);
  if (g.dismissStreak >= 2) why.push(`${g.dismissStreak} suggestions dismissed in a row`);
  return {
    novelty_appetite: novelty,
    density: g.bigKept > g.bigReverts ? "high" : g.bigReverts > g.bigKept ? "low" : "medium",
    cadence: g.dismissStreak >= 2 ? "fewer" : g.novelKept + g.classicKept >= 2 && !g.novelDismissed && !g.classicDismissed ? "more" : "same",
    change_size: g.replacedReverts > g.replacedKept ? "small" : g.replacedKept >= 2 && !g.replacedReverts ? "large" : "medium",
    explanation: g.medianReactSec === null ? "normal" : g.medianReactSec < 10 ? "brief" : g.medianReactSec > 45 ? "detailed" : "normal",
    reason: why.join(", ") || "first reactions to suggestions",
  };
}

const noveltyLevel = (x: number) => (x < 0.3 ? "low" : x > 0.65 ? "high" : "medium");

// Live mode: the planner model reads the same signals and may refine the rules' answer.
async function learnPrefs(s: UserState, g: Signals): Promise<MetaPrefs> {
  const base = rules(g);
  if (!isLive()) return base;
  const counts = { ...g, evidence: undefined };
  const prompt = [
    "Reaction counts:", JSON.stringify(counts), "",
    "Current meta-preferences:", JSON.stringify(Object.fromEntries(s.beliefs.filter((b) => b.level === "meta").map((b) => [b.key, b.value]))), "",
    "A rule-based estimate:", JSON.stringify(base), "",
    "novelty_appetite is 0 (only classic month and week views) to 1 (loves invented views); below 0.3 means stop offering invented views.",
    `Reply with JSON only, same keys as the estimate: ${JSON.stringify(Object.keys(base))}. reason: one short clause naming the evidence.`,
  ].join("\n");
  try {
    return await structured(Meta, systemFor(META_CORE, s, "meta"), prompt, { role: "planner", temperature: 0.2 });
  } catch (err) {
    console.warn(`[meta] planner failed, using rules: ${(err as Error).message}`);
    return base;
  }
}

function toBeliefs(m: MetaPrefs, g: Signals, at: string): Belief[] {
  const conf = (n: number) => round2(Math.min(0.95, 0.3 + 0.15 * n));
  const nov = noveltyLevel(m.novelty_appetite);
  const said: Record<keyof Omit<MetaPrefs, "reason">, string> = {
    novelty_appetite: nov === "low" ? "Prefers classic month and week views over invented ones" : nov === "high" ? "Enjoys views designed just for them" : "Open to an invented view now and then",
    density: { low: "Likes views with few elements", medium: "Fine with a moderately busy view", high: "Happy with dense, information-rich views" }[m.density],
    cadence: { fewer: "Wants suggestions less often", same: "Suggestion pace is about right", more: "Welcomes suggestions often" }[m.cadence],
    change_size: { small: "Wants small steps, not a whole new view", medium: "Accepts moderate changes", large: "Comfortable with big redesigns" }[m.change_size],
    explanation: { brief: "Reacts fast; keep explanations to one line", normal: "Reads a short explanation", detailed: "Takes time to read the reasoning" }[m.explanation],
  };
  return (Object.keys(said) as (keyof typeof said)[]).map((k) => ({
    key: `meta.${k}`, statement: said[k], value: m[k], confidence: conf(g.evidence[k].length), evidence: g.evidence[k].slice(-10), level: "meta", updatedAt: at,
  }));
}

// What makes a rewrite meaningful: one of the coarse levels changed, not a decimal.
const levels = (bs: Belief[]) => {
  const v = (k: string) => bs.find((b) => b.key === `meta.${k}`)?.value;
  const n = v("novelty_appetite");
  return JSON.stringify([typeof n === "number" ? noveltyLevel(n) : null, v("density"), v("cadence"), v("change_size"), v("explanation")]);
};

// ---------- E5: adaptation knobs ----------

function knobs(m: MetaPrefs, g: Signals) {
  const reverts = g.novelQuickReverts + g.novelSlowReverts + g.classicReverts;
  const threshold = round2(clamp(0.7 + 0.05 * g.dismissStreak + 0.03 * reverts - 0.03 * (g.novelKept + g.classicKept), 0.6, 0.9));
  const minGapMinutes = m.cadence === "fewer" ? 60 * Math.max(0, Math.min(4, g.dismissStreak - 1)) : m.cadence === "more" ? 0 : reverts >= 2 ? 15 : 0;
  return { threshold, minGapMinutes };
}

// ---------- E6: learned sections ----------

function templates(m: MetaPrefs, s: UserState): Record<AgentName, string> {
  const nov = noveltyLevel(m.novelty_appetite);
  const brief = m.explanation === "brief";
  return {
    designer: [
      `- Novelty appetite: ${nov}. ${nov === "low" ? "Offer only classic MonthGrid and WeekGrid views; invented views were undone." : nov === "high" ? "Invented, combined views are welcome." : "Prefer classic views; offer an invented view only when no classic one fits."}`,
      `- Density: ${m.density}. ${m.density === "low" ? "Keep views to a few elements." : m.density === "high" ? "Dense views with several sections are fine." : "A handful of elements is fine."}`,
      `- Change size: ${m.change_size}. ${m.change_size === "small" ? "Change one thing about the current view rather than replacing it." : m.change_size === "large" ? "A complete redesign is acceptable." : "Moderate changes are fine."}`,
      `- Explanations: ${m.explanation}. ${brief ? "Keep the reason to one short sentence." : m.explanation === "detailed" ? "Give the full reasoning, with numbers." : "One or two sentences."}`,
    ].join("\n"),
    intent: brief ? "- Keep confirmations and answers to one short line." : `- Explain what will change in ${m.explanation === "detailed" ? "full, listing each event" : "one or two sentences"}.`,
    importer: `- Summarize imports in ${brief ? "one line with counts" : "a short list grouped by category"}.${m.change_size === "small" ? "\n- Prefer importing in small batches the person can review." : ""}`,
    habit: `- Only report a habit once its confidence reaches ${s.settings.threshold.toFixed(2)}.${m.cadence === "fewer" ? "\n- This person dismisses suggestions often; prefer fewer, stronger habits." : ""}`,
    meta: [
      `- Strongest signal so far: ${m.reason}.`,
      nov === "low" ? "- Treat any new invented view with suspicion; one revert of a classic view should count less." : "- Weigh reverts within minutes most heavily.",
    ].join("\n"),
  };
}

async function writeSections(s: UserState, m: MetaPrefs): Promise<Record<AgentName, string>> {
  const base = templates(m, s);
  if (!isLive()) return base;
  const prompt = [
    "Rewrite the learned \"About this person\" section for each agent from these meta-preferences:", JSON.stringify(m), "",
    "Current sections:", JSON.stringify(Object.fromEntries(AGENTS.map((a) => [a, learnedSection(s, a)]))), "",
    "A template version:", JSON.stringify(base), "",
    `Agents: designer (proposes calendar views; keep its "- Novelty appetite: <level>." line), intent (turns typed requests into calendar edits), importer (imports .ics, text and email), habit (learns planning habits), meta (you).`,
    `Reply with JSON only: {${AGENTS.map((a) => `"${a}": "<2 to 5 short bullet lines>"`).join(", ")}}`,
  ].join("\n");
  try {
    return await structured(Sections, systemFor(META_CORE, s, "meta"), prompt, { role: "planner", temperature: 0.2 });
  } catch (err) {
    console.warn(`[meta] planner could not write sections, using templates: ${(err as Error).message}`);
    return base;
  }
}

// ---------- E7: replay before adoption ----------

const shape = (spec: Proposal["spec"]) => JSON.stringify(Object.values(spec.elements).map((e) => e.type + JSON.stringify(e.props)).sort());

async function replay(s: UserState, designerLearned: string): Promise<{ ok: boolean; notes: string[] }> {
  const system = withLearned(systemPrompt(), designerLearned);
  const rejected = s.proposals.filter((p) => p.status === "dismissed" || p.status === "undone");
  const history = rejected.map((p) => ({ title: p.title, status: p.status }));
  const runs = [
    { name: s.name, persona: personaOf(s), spec: s.spec ?? DAY_ONE, history, own: true },
    ...PERSONAS.filter((p) => p.id !== s.id).map((p) => ({ name: p.name, persona: p, spec: DAY_ONE, history: [], own: false })),
  ].filter((r) => r.persona.events.length);
  const notes: string[] = [];
  let ok = true;
  await Promise.all(runs.map(async (r) => {
    try {
      const out = await design(r.persona, { personaId: r.persona.id, currentSpec: r.spec, history: r.history }, system, isLive() ? 1 : undefined);
      const p = out.proposal;
      if (!p) {
        const failed = out.trace.some((t) => t.text.startsWith("No draft passed"));
        if (failed) ok = false;
        notes.push(`${r.name}: ${failed ? "no draft passed the critic" : "no change proposed"}`);
      } else if (r.own && rejected.some((x) => x.title === p.title || shape(x.spec) === shape(p.spec))) {
        ok = false;
        notes.push(`${r.name}: would re-propose "${p.title}", which was ${rejected.find((x) => x.title === p.title || shape(x.spec) === shape(p.spec))!.status}`);
      } else {
        notes.push(`${r.name}: "${p.title}" (${isNovel(p.spec) ? "invented" : "classic"}) passes the critic`);
      }
    } catch (err) {
      ok = false;
      notes.push(`${r.name}: replay failed (${(err as Error).message})`);
    }
  }));
  return { ok, notes };
}

function unifiedDiff(agent: AgentName, from: number, to: number, a: string, b: string): string {
  return createTwoFilesPatch(`${agent} v${from}`, `${agent} v${to}`, a ? `${a}\n` : "", `${b}\n`, "", "", { context: 2 })
    .split("\n").filter((l) => !l.startsWith("====")).join("\n").trim();
}

// ---------- rollback ----------

// Makes `version` the active one for an agent (0 = no learned section).
export async function rollbackPrompt(userId: string, agent: AgentName, version: number, why: string): Promise<boolean> {
  return update(userId, (s) => {
    const versions = s.prompts.filter((p) => p.agent === agent);
    const target = versions.find((p) => p.version === version);
    if (version !== 0 && !target) return false;
    const was = activePrompt(s, agent);
    for (const p of versions) p.active = p === target;
    activity(s, ROLE, `Rolled back the ${agent} prompt from v${was?.version ?? 0} to v${version}: ${why}`, unifiedDiff(agent, was?.version ?? 0, version, was?.learned ?? "", target?.learned ?? ""));
    return true;
  });
}

// A revert of a proposal made under a version counts against that version.
async function rollBackBadVersions(userId: string, reverted: Interaction) {
  const used = (reverted.payload.promptVersions ?? {}) as Record<string, number>;
  const s = getUser(userId)!;
  for (const [agent, version] of Object.entries(used) as [AgentName, number][]) {
    const v = s.prompts.find((p) => p.agent === agent && p.version === version);
    if (!v?.active) continue;
    const against = s.interactions.filter((i) => i.kind === "proposal_reverted" && (i.payload.promptVersions as Record<string, number> | undefined)?.[agent] === version).length;
    if (against < REVERTS_TO_ROLL_BACK) continue;
    const back = s.prompts.filter((p) => p.agent === agent && p.version < version && p.replay?.ok !== false).at(-1)?.version ?? 0;
    await rollbackPrompt(userId, agent, back, `${against} suggestions made under v${version} were reverted.`);
  }
}

// ---------- the loop ----------

async function learn(userId: string, trigger?: Interaction) {
  const s = getUser(userId);
  if (!s) return;
  if (trigger?.kind === "proposal_reverted") await rollBackBadVersions(userId, trigger);

  const g = signals(s);
  const m = await learnPrefs(s, g);
  const at = new Date().toISOString();
  const beliefs = toBeliefs(m, g, at);
  const before = levels(s.beliefs);
  const changed = before !== levels(beliefs);

  const wrote = await update(userId, (st) => {
    for (const b of beliefs) {
      const old = st.beliefs.find((x) => x.key === b.key);
      if (old && JSON.stringify(old.value) === JSON.stringify(b.value)) {
        Object.assign(old, { confidence: b.confidence, evidence: b.evidence, updatedAt: at });
        continue;
      }
      const from = old ? (typeof old.value === "number" ? old.value.toFixed(2) : String(old.value)) : "unknown";
      const to = typeof b.value === "number" ? `${b.value.toFixed(2)} (${noveltyLevel(b.value)})` : String(b.value);
      activity(st, ROLE, `${b.key}: ${from} → ${to}. ${b.statement} (${m.reason}).`);
      st.beliefs = [...st.beliefs.filter((x) => x.key !== b.key), b];
    }
    const k = knobs(m, g);
    // The person's own "how often" choice is a floor, unless they plainly want more suggestions.
    if (m.cadence !== "more") k.minGapMinutes = Math.max(k.minGapMinutes, st.settings.minGapMinutes);
    const moved = [
      k.threshold !== st.settings.threshold && `proposal threshold ${st.settings.threshold.toFixed(2)} → ${k.threshold.toFixed(2)}`,
      k.minGapMinutes !== st.settings.minGapMinutes && `minimum gap ${st.settings.minGapMinutes} → ${k.minGapMinutes} min`,
    ].filter(Boolean);
    if (moved.length) {
      activity(st, ROLE, `Moved the ${moved.join(" and the ")} (${m.reason}).`);
      Object.assign(st.settings, k);
    }
    return true;
  }, s);
  if (changed && wrote) await rewrite(userId, m, beliefs.flatMap((b) => b.evidence));
}

async function rewrite(userId: string, m: MetaPrefs, evidence: string[]) {
  const s = getUser(userId)!;
  const sections = await writeSections(s, m);
  const todo = AGENTS.filter((a) => sections[a].trim() !== learnedSection(s, a));
  if (!todo.length) return;
  const designer = todo.includes("designer") ? sections.designer.trim() : learnedSection(s, "designer");
  await update(userId, (st) => activity(st, ROLE, `Meta-preferences changed (${m.reason}). Replaying a rewrite of ${todo.length} prompt${todo.length > 1 ? "s" : ""} against ${st.name} and the sample personas.`));
  const result = await replay(s, designer);
  const reason = `${noveltyLevel(m.novelty_appetite)} novelty appetite, ${m.density} density, ${m.change_size} changes, ${m.explanation} explanations: ${m.reason}.`;
  await update(userId, (st) => {
    activity(st, "Critic", `Replay ${result.ok ? "passed" : "failed"}: ${result.notes.join("; ")}`);
    for (const agent of todo) {
      const prev = activePrompt(st, agent);
      const version = Math.max(0, ...st.prompts.filter((p) => p.agent === agent).map((p) => p.version)) + 1;
      const learned = sections[agent].trim();
      const diff = unifiedDiff(agent, prev?.version ?? 0, version, prev?.learned ?? "", learned);
      const v: PromptVersion = { agent, version, learned, diff, reason, evidence: evidence.slice(-20), replay: result, active: result.ok, at: new Date().toISOString() };
      if (result.ok) for (const p of st.prompts) if (p.agent === agent) p.active = false;
      st.prompts.push(v);
      activity(st, ROLE, result.ok ? `Rewrote the ${agent} prompt's learned section (v${version}).` : `Kept ${agent} v${prev?.version ?? 0}: the replay of v${version} failed.`, diff);
    }
  }, s);
}

// One run at a time per person; triggers that arrive meanwhile queue behind it.
const queue = new Map<string, Promise<void>>();
function schedule(userId: string, trigger?: Interaction) {
  const next = (queue.get(userId) ?? Promise.resolve()).then(() => learn(userId, trigger)).catch((err) => console.error("[meta]", err));
  queue.set(userId, next);
}

const TIMER_MS = 10 * 60_000;

export function startMetaLoop() {
  onInteraction((userId, i) => {
    if (OUTCOMES.has(i.kind) || backToClassic(i)) schedule(userId, i);
  });
  // Reaction times and slow reverts change with the clock, so re-learn now and then.
  setInterval(() => {
    for (const u of listUsers()) if (getUser(u.id)?.interactions.some((i) => OUTCOMES.has(i.kind))) schedule(u.id);
  }, TIMER_MS).unref();
}

export async function logRollback(userId: string, agent: AgentName, version: number) {
  const ok = await rollbackPrompt(userId, agent, version, "rolled back by hand.");
  if (ok) await log(userId, "prompt_rollback", { agent, version }, "manual");
  return ok;
}
