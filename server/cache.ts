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
export async function cached<T>(parts: unknown[], make: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
  const key = keyOf(parts);
  if (enabled && key in db.data) return { value: db.data[key] as T, hit: true };
  const value = await make();
  if (enabled) {
    db.data[key] = value;
    await db.write();
  }
  return { value, hit: false };
}
