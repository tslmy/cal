import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { z } from "zod";
import { MODELS, resolveModels } from "./models";
import { cached } from "./cache";

// Shared model access for every agent: Crusoe's OpenAI-compatible endpoint, a per-model queue
// under the rate limit, backoff on 429/503, and Zod-validated JSON with retries (E10, E14).

// Nemotron reasons before answering by default, which can eat the whole token budget and leave
// no JSON. Agents produce structured output, so thinking is off unless asked for.
const THINKING = process.env.DESIGNER_THINKING === "1";
// Crusoe limits requests per model, so calls to one model take turns.
const IN_FLIGHT = Number(process.env.DESIGNER_CONCURRENCY ?? 2);
const BASE_URL = process.env.CRUSOE_BASE_URL ?? "https://api.inference.crusoecloud.com/v1";
const VALIDATION_RETRIES = 2;
// Output cap per call. A reply cut off at the cap (a long bulk import, or reasoning that ran on)
// is asked for again with double the cap, up to MAX_TOKENS.
const FIRST_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 8000);
const MAX_TOKENS = 64000;

export const crusoe = process.env.CRUSOE_API_KEY
  ? createOpenAICompatible({ name: "crusoe", baseURL: BASE_URL, apiKey: process.env.CRUSOE_API_KEY })
  : null;
export const isLive = () => !!crusoe;
export const mode = (): "live" | "mock" => (crusoe ? "live" : "mock");

// Checked once per server start; a failed check is retried on the next request.
let resolved: Promise<string[]> | null = null;
export function checkModels(): Promise<string[]> {
  if (!crusoe) return Promise.resolve([]);
  resolved ??= resolveModels(BASE_URL, process.env.CRUSOE_API_KEY!).catch((err) => {
    resolved = null;
    return [`Could not list models: ${(err as Error).message}`];
  });
  return resolved;
}

// An error from the API itself (wrong model, key or URL). Retrying would not help.
export class ModelError extends Error {}
function describe(err: unknown, model: string): string {
  const e = err as { statusCode?: number; url?: string; responseBody?: string; message?: string };
  const body = e.responseBody ? `: ${e.responseBody.replace(/\s+/g, " ").slice(0, 200)}` : e.message ? `: ${e.message}` : "";
  return `Model call failed${e.statusCode ? ` (${e.statusCode})` : ""} for ${model}${e.url ? ` at ${e.url}` : ""}${body}`;
}

export function parseJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").replace(/```(?:json)?/g, "").trim();
  // A top-level array ("[{...}, {...}]") is kept whole rather than cut down to its first object.
  const arr = cleaned.indexOf("[");
  const array = arr >= 0 && (cleaned.indexOf("{") < 0 || arr < cleaned.indexOf("{"));
  const start = array ? arr : cleaned.indexOf("{");
  const end = array ? cleaned.lastIndexOf("]") : cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(cleaned ? `no JSON object in the reply: "${cleaned.slice(0, 80)}..."` : "the reply was empty");
  return JSON.parse(cleaned.slice(start, end + 1));
}

// JSON mode and the thinking switch are extensions; if the endpoint rejects them, drop them for good.
let extras = true;

const queues = new Map<string, { active: number; waiting: (() => void)[] }>();
async function slot<T>(model: string, run: () => Promise<T>): Promise<T> {
  const q = queues.get(model) ?? { active: 0, waiting: [] };
  queues.set(model, q);
  if (q.active >= IN_FLIGHT) await new Promise<void>((r) => q.waiting.push(r));
  q.active++;
  try {
    return await run();
  } finally {
    q.active--;
    q.waiting.shift()?.();
  }
}

export type Role = keyof typeof MODELS;

// One raw call. Throws ModelError for API problems.
// `cache: true` replays an earlier answer to the exact same call from the replay cache, so a
// rehearsed demo doesn't wait on (or pay for) the same inference twice.
export async function callModel(system: string, prompt: string, opts: { role?: Role; model?: string; temperature?: number; cache?: boolean } = {}): Promise<string> {
  // Every agent, not just the designer, needs the ids checked against what the endpoint serves.
  await checkModels();
  const model = opts.model ?? MODELS[opts.role ?? "designer"];
  if (opts.cache) return (await cached(["call", model, system, prompt, opts.temperature ?? 0.3], () => callModel(system, prompt, { ...opts, model, cache: false }))).value;
  let cap = FIRST_TOKENS;
  for (let attempt = 0; ; attempt++) {
    try {
      const { text, finishReason } = await slot(model, () =>
        generateText({
          model: crusoe!(model),
          system,
          prompt,
          temperature: opts.temperature ?? 0.3,
          maxOutputTokens: cap,
          maxRetries: 0, // retried below, with longer waits that fit a per-minute limit
          providerOptions: extras ? { crusoe: { response_format: { type: "json_object" }, chat_template_kwargs: { enable_thinking: THINKING } } } : {},
        }),
      );
      if (finishReason === "length") {
        if (cap < MAX_TOKENS) {
          cap = Math.min(MAX_TOKENS, cap * 2);
          console.warn(`[llm] ${model} hit the output cap; asking again with ${cap} tokens.`);
          attempt--; // not a rate-limit retry
          continue;
        }
        if (!text.trim()) return "(ran out of tokens before answering)";
      }
      return text;
    } catch (err) {
      const e = err as { statusCode?: number; responseHeaders?: Record<string, string> };
      if (extras && (e.statusCode === 400 || e.statusCode === 422)) {
        console.warn(`[llm] ${describe(err, model)}. Retrying without JSON mode and the thinking switch.`);
        extras = false;
        continue;
      }
      // Crusoe's limit is shared and bursty (several 429s in a row, then room again), so keep
      // trying for about 90 seconds before giving up on the call.
      if (attempt < 6 && (e.statusCode === 429 || e.statusCode === 503)) {
        const after = Number(e.responseHeaders?.["retry-after"]);
        await new Promise((r) => setTimeout(r, after > 0 ? after * 1000 : Math.min(30000, 2000 * 2 ** attempt) + Math.random() * 1000));
        continue;
      }
      throw new ModelError(describe(err, model));
    }
  }
}

// A JSON answer validated against a Zod schema. Invalid output is sent back with the validation
// error, up to VALIDATION_RETRIES times (E10). Throws if it never validates.
export async function structured<S extends z.ZodType>(
  schema: S,
  system: string,
  prompt: string,
  opts: { role?: Role; model?: string; temperature?: number; cache?: boolean } = {},
): Promise<z.infer<S>> {
  let last = "";
  let problem = "";
  for (let i = 0; i <= VALIDATION_RETRIES; i++) {
    const p = problem ? `${prompt}\n\nYOUR LAST ANSWER WAS INVALID (${problem}). Last answer:\n${last}\n\nReply again with corrected JSON only.` : prompt;
    last = await callModel(system, p, opts);
    try {
      const parsed = schema.safeParse(parseJson(last));
      if (parsed.success) return parsed.data;
      problem = parsed.error.issues.slice(0, 5).map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`).join("; ");
    } catch (err) {
      problem = (err as Error).message;
    }
  }
  throw new Error(`Output never matched the schema: ${problem}`);
}
