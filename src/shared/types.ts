import type { CalendarSpec } from "./catalog";

// Where an event or an interaction came from (P7). The learner can weigh sources differently.
export type Source = "typed" | "ics" | "text" | "email" | "sample" | "agent" | "manual";

// How exact the stored time is (P2): vague input keeps its vagueness.
export type Precision = "exact" | "approximate" | "day" | "week" | "span";

export type CalEvent = {
  id: string;
  title: string;
  start: string; // YYYY-MM-DD or YYYY-MM-DDTHH:mm
  end: string; // inclusive day for all-day events, end time for timed ones
  category: string;
  precision?: Precision;
  recurrence?: string; // RRULE text, informational; occurrences are stored expanded
  source?: Source;
  uid?: string; // external id (.ics UID, email message id) used to skip duplicates
};

// ---------- operations on events (intent parser, imports, undo) ----------

export type EventDraft = Omit<CalEvent, "id"> & { id?: string };

// Bulk operations are always resolved to explicit event ids before anything is written (E12).
export type Operation =
  | { op: "create"; event: EventDraft }
  | { op: "update"; id: string; before: CalEvent; after: CalEvent }
  | { op: "delete"; id: string; before: CalEvent };

// A batch of operations shown as a diff before it is applied (P3).
export type ChangeSet = {
  id: string;
  summary: string; // one line for the preview and the activity log
  source: Source;
  ops: Operation[];
  answer?: string; // for read queries: the answer to show instead of a diff
};

// ---------- interaction log (E1) ----------

export type InteractionKind =
  | "create" | "update" | "delete" | "query"
  | "import"
  | "view_switch"
  | "proposal_shown" | "proposal_accepted" | "proposal_dismissed" | "proposal_reverted"
  | "belief_deleted"
  | "prompt_rollback"
  | "settings_changed"
  | "dwell"; // time spent in a view

export type Interaction = {
  id: string;
  at: string; // ISO timestamp
  kind: InteractionKind;
  source: Source;
  payload: Record<string, unknown>;
};

// ---------- beliefs (E2, E3) ----------

export type Belief = {
  key: string; // e.g. "no_weekend_events", or "meta.novelty_appetite"
  statement: string; // plain language for the "What I've learned" panel
  value: string | number | boolean | string[];
  confidence: number; // 0 to 1
  evidence: string[]; // interaction ids
  level: "habit" | "meta";
  updatedAt: string;
};

// ---------- proposals ----------

export type Proposal = {
  id: string;
  title: string;
  reason: string;
  spec: CalendarSpec;
  status: "suggested" | "accepted" | "dismissed" | "undone";
  beliefKeys?: string[];
  beliefConfidence?: Record<string, number>; // confidence of each relied-on belief when shown, for P19
  promptVersions?: Record<string, number>; // agent -> version used to make it
  novel?: boolean; // an invented view rather than a classic month or week
  previous?: CalendarSpec; // the view it replaced, for Undo
  at?: string;
};

// ---------- prompts (E6, E7) ----------

export type AgentName = "intent" | "importer" | "habit" | "meta" | "designer";

export type PromptVersion = {
  agent: AgentName;
  version: number;
  learned: string; // the "About this person" section; the core is fixed in code
  diff: string; // unified diff from the previous version
  reason: string;
  evidence: string[];
  replay?: { ok: boolean; notes: string[] };
  active: boolean;
  at: string;
};

// ---------- agent activity (E9) ----------

export type TraceStep = { role: string; text: string; at?: string; diff?: string };

// ---------- the whole per-person state, persisted server-side (E13) ----------

export type Settings = {
  threshold: number; // confidence needed before a proposal (E5)
  minGapMinutes: number; // minimum gap between proposals (E5)
  proposalsOn: boolean; // P12
};

export type UserState = {
  id: string;
  name: string;
  role: string;
  events: CalEvent[];
  interactions: Interaction[];
  beliefs: Belief[];
  proposals: Proposal[];
  prompts: PromptVersion[];
  activity: TraceStep[];
  settings: Settings;
  spec: CalendarSpec; // the view on screen now
  undo: { changeSetId: string; ops: Operation[] }[]; // applied change sets, newest last
  learnedThrough?: number; // how many interactions the habit learner's last finished pass had read
};

// ---------- sample personas (seed data) ----------

// Hand-written profile from the POC; kept only as seed beliefs for the sample users.
export type Profile = {
  facts: string[];
  signals: Record<string, string | number | boolean | string[]>;
  confidence: number;
};

export type Persona = {
  id: string;
  name: string;
  role: string;
  profile: Profile;
  events: CalEvent[];
  tailored?: { title: string; reason: string; spec: CalendarSpec }; // a view already accepted at the start
};

// ---------- designer API ----------

export type DesignRequest = {
  personaId: string;
  currentSpec: CalendarSpec;
  history: { title: string; status: Proposal["status"] }[];
};

export type DesignResponse = {
  mode: "live" | "mock";
  proposal: Omit<Proposal, "status"> | null;
  trace: TraceStep[];
};
