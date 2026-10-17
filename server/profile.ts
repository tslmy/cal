import type { Persona, UserState } from "../src/shared/types";

// What the designer reads: the person's events plus the habit beliefs, flattened into the
// POC's Profile shape. Belief keys double as designer signals (e.g. "timeScales", "weekendEvents").
export function personaOf(s: UserState): Persona {
  const habits = s.beliefs.filter((b) => b.level === "habit");
  const confident = habits.filter((b) => b.confidence >= s.settings.threshold);
  return {
    id: s.id,
    name: s.name,
    role: s.role,
    events: s.events,
    profile: {
      facts: confident.map((b) => `${b.statement} (confidence ${b.confidence.toFixed(2)})`),
      signals: Object.fromEntries(confident.filter((b) => !b.key.startsWith("seed.")).map((b) => [b.key, b.value])),
      confidence: confident.length ? Math.max(...confident.map((b) => b.confidence)) : 0,
    },
  };
}
