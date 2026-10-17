import type { AgentName, PromptVersion, UserState } from "../src/shared/types";

// Every agent's system prompt has two parts (E6): a fixed core, written in code by each agent,
// and a learned "About this person" section that the meta-learner rewrites. The core comes first
// and stays byte-identical so Crusoe's prefix cache still hits.

export function activePrompt(state: UserState, agent: AgentName): PromptVersion | undefined {
  return state.prompts.filter((p) => p.agent === agent && p.active).at(-1);
}

export function learnedSection(state: UserState, agent: AgentName): string {
  return activePrompt(state, agent)?.learned.trim() ?? "";
}

export function systemFor(core: string, state: UserState, agent: AgentName): string {
  const learned = learnedSection(state, agent);
  return learned ? `${core}\n\nABOUT THIS PERSON (learned; follow it unless it conflicts with the rules above):\n${learned}` : core;
}

export const promptVersionsUsed = (state: UserState): Record<string, number> =>
  Object.fromEntries(state.prompts.filter((p) => p.active).map((p) => [p.agent, p.version]));
