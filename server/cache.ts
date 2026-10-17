import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { JSONFilePreset } from "lowdb/node";

// Replay cache for model answers, so a demo can fast-forward through inferences it has already
// made. Kept in its own file (committable, unlike data/) and keyed by whatever the caller says
// determines the answer. LLM_CACHE=0 turns it off; delete the file to start over.

const file = process.env.LLM_CACHE_FILE ?? "cache/llm.json";
const enabled = process.env.LLM_CACHE !== "0";
mkdirSync(file.replace(/\/[^/]*$/, ""), { recursive: true });
const db = await JSONFilePreset<Record<string, unknown>>(file, {});

const keyOf = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

// Returns the cached answer for these key parts, or runs `make`, stores and returns its answer.
// `fallbacks` are looser keys tried in order when the exact one misses, so answers made under an
// older model or prompt still replay instead of spending tokens again. The answer is stored under
// the exact key and the first fallback.
export async function cached<T>(parts: unknown[], make: () => Promise<T>, fallbacks: unknown[][] = []): Promise<{ value: T; hit: boolean }> {
  if (enabled) {
    for (const k of [parts, ...fallbacks].map(keyOf)) if (k in db.data) return { value: db.data[k] as T, hit: true };
  }
  const value = await make();
  if (enabled) {
    for (const k of [parts, ...fallbacks.slice(0, 1)].map(keyOf)) db.data[k] = value;
    await db.write();
  }
  return { value, hit: false };
}
