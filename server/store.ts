import { mkdirSync } from "node:fs";
import { JSONFilePreset } from "lowdb/node";
import { PERSONAS } from "../src/shared/personas";
import { TODAY } from "../src/shared/dates";
import type { CalendarSpec } from "../src/shared/catalog";
import type { Belief, Interaction, InteractionKind, Persona, Source, TraceStep, UserState } from "../src/shared/types";

// All state lives server-side in one JSON file (E13), so a page reload keeps events, beliefs,
// proposals and prompt versions (P20). lowdb serializes writes for us.

export const DAY_ONE: CalendarSpec = { root: "view", elements: { view: { type: "MonthGrid", props: { month: TODAY.slice(0, 7) }, children: [] } } };
export const DEFAULT_SETTINGS = { threshold: 0.7, minGapMinutes: 0, proposalsOn: true };

// A blank person for the demo: no events, no beliefs, nothing hand-written.
const NEW_PERSON: Persona = { id: "you", name: "You", role: "New here", profile: { facts: [], signals: {}, confidence: 0 }, events: [] };

let counter = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;
const now = () => new Date().toISOString();

function seed(p: Persona): UserState {
  // Sample users start with their POC profile as seed beliefs, marked as such.
  const beliefs: Belief[] = p.profile.facts.map((f, i) => ({
    key: `seed.${i}`, statement: f, value: true, confidence: p.profile.confidence, evidence: [], level: "habit", updatedAt: now(),
  }));
  return {
    id: p.id, name: p.name, role: p.role,
    events: p.events.map((e) => ({ ...e, source: e.source ?? "sample" })),
    interactions: [], beliefs, proposals: [], prompts: [], activity: [],
    settings: { ...DEFAULT_SETTINGS }, spec: DAY_ONE, undo: [],
  };
}

const SEEDS = [NEW_PERSON, ...PERSONAS];
type Data = { users: Record<string, UserState> };

const file = process.env.EVOLVE_DATA ?? "data/evolve.json";
mkdirSync(file.replace(/\/[^/]*$/, ""), { recursive: true });
const db = await JSONFilePreset<Data>(file, { users: {} });
for (const p of SEEDS) db.data.users[p.id] ??= seed(p);
await db.write();

export const listUsers = () => SEEDS.map((p) => ({ id: p.id, name: db.data.users[p.id].name, role: db.data.users[p.id].role }));

export function getUser(id: string): UserState | undefined {
  return db.data.users[id];
}

// Mutates one person's state and saves it.
export async function update<T>(id: string, fn: (s: UserState) => T): Promise<T> {
  const s = db.data.users[id];
  if (!s) throw new Error(`no such user: ${id}`);
  const out = fn(s);
  await db.write();
  return out;
}

export async function resetUser(id: string) {
  const p = SEEDS.find((x) => x.id === id);
  if (!p) throw new Error(`no such user: ${id}`);
  db.data.users[id] = seed(p);
  await db.write();
}

// ---------- agent activity (E9) ----------

export function activity(s: UserState, role: string, text: string, diff?: string) {
  s.activity.push({ role, text, at: now(), ...(diff ? { diff } : {}) });
  if (s.activity.length > 300) s.activity.splice(0, s.activity.length - 300);
}
export async function addActivity(id: string, steps: TraceStep[]) {
  await update(id, (s) => steps.forEach((t) => activity(s, t.role, t.text, t.diff)));
}

// ---------- interaction log (E1) ----------

type Listener = (userId: string, i: Interaction) => void;
const listeners: Listener[] = [];
// The adaptation loop subscribes here; agents read the log, never the UI.
export const onInteraction = (l: Listener) => listeners.push(l);

export async function log(userId: string, kind: InteractionKind, payload: Record<string, unknown> = {}, source: Source = "manual"): Promise<Interaction> {
  const i: Interaction = { id: newId("i"), at: now(), kind, source, payload };
  await update(userId, (s) => s.interactions.push(i));
  for (const l of listeners) {
    try {
      l(userId, i);
    } catch (err) {
      console.error("[store] listener failed", err);
    }
  }
  return i;
}
