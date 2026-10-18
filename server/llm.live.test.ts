import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Live mode against a stubbed endpoint: a fake key, a fake /models list and a fake generateText,
// so the retry, cache and model-resolution paths run without the network.
const { generateText } = vi.hoisted(() => {
  process.env.CRUSOE_API_KEY = "test-key";
  process.env.LLM_CACHE = "1";
  process.env.LLM_CACHE_FILE = `node_modules/.tmp/test/llm-${process.env.VITEST_POOL_ID ?? 0}.json`;
  return { generateText: vi.fn() };
});
vi.mock("ai", () => ({ generateText }));

const served = ["nvidia/nvidia-nemotron-3-super-120b-a12b", "nvidia/Nemotron-3-Nano-30B-A3B", "nvidia/Nemotron-Nano-Omni"];
vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: served.map((id) => ({ id })) }))));

const { rmSync } = await import("node:fs");
rmSync(process.env.LLM_CACHE_FILE!, { force: true });
const { callModel, checkModels, isLive, ModelError, structured } = await import("./llm");
const { MODELS, resolveModels } = await import("./models");

const reply = (text: string, finishReason = "stop") => ({ text, finishReason });
let n = 0;
const fresh = () => `prompt ${n++}`; // a new prompt per call, so the cache never answers

beforeEach(() => generateText.mockReset());

describe("models", () => {
  it("swaps in what the endpoint serves and notes what it lacks", async () => {
    expect(isLive()).toBe(true);
    const notes = await checkModels();
    expect(MODELS.planner).toBe("nvidia/nvidia-nemotron-3-super-120b-a12b"); // only the case differed
    expect(MODELS.designer).toBe("nvidia/Nemotron-3-Nano-30B-A3B"); // no Lightning, so Nano, and the text model over the omni one
    expect(notes.some((x) => x.startsWith("designer:"))).toBe(true);
  });

  it("says when no Nemotron is served, and when /models fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "other/model" }] })));
    expect((await resolveModels("https://x/v1/", "k")).some((x) => x.startsWith("No Nemotron model"))).toBe(true);
    vi.mocked(fetch).mockResolvedValueOnce(new Response("nope", { status: 401 }));
    await expect(resolveModels("https://x/v1", "k")).rejects.toThrow("answered 401");
  });
});

describe("callModel", () => {
  it("replays a cached answer instead of calling again", async () => {
    generateText.mockResolvedValue(reply('{"a":1}'));
    const p = fresh();
    expect(await callModel("sys", p)).toBe('{"a":1}');
    expect(await callModel("sys", p)).toBe('{"a":1}');
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("asks again with a bigger cap when cut off", async () => {
    generateText.mockResolvedValueOnce(reply("", "length")).mockResolvedValueOnce(reply("done"));
    expect(await callModel("sys", fresh(), { cache: false })).toBe("done");
    expect(generateText.mock.calls.map((c) => c[0].maxOutputTokens)).toEqual([8000, 16000]);
  });

  it("drops JSON mode when the endpoint rejects it", async () => {
    generateText.mockRejectedValueOnce({ statusCode: 400, responseBody: "unknown field response_format" }).mockResolvedValueOnce(reply("ok"));
    expect(await callModel("sys", fresh(), { cache: false })).toBe("ok");
    expect(generateText.mock.calls[1][0].providerOptions).toEqual({});
  });

  it("waits out a rate limit", async () => {
    generateText.mockRejectedValueOnce({ statusCode: 429, responseHeaders: { "retry-after": "0.001" } }).mockResolvedValueOnce(reply("ok"));
    expect(await callModel("sys", fresh(), { cache: false })).toBe("ok");
  });

  it("turns API errors into ModelError", async () => {
    generateText.mockRejectedValueOnce({ statusCode: 404, url: "https://x/v1/chat", message: "model not found" });
    const err = await callModel("sys", fresh(), { cache: false }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.message).toMatch(/^Model call failed \(404\) for .* at https:\/\/x\/v1\/chat: model not found$/);
  });
});

describe("structured", () => {
  const Shape = z.object({ n: z.number() });

  it("sends invalid output back with the problem", async () => {
    generateText.mockResolvedValueOnce(reply('{"n":"one"}')).mockResolvedValueOnce(reply('{"n":1}'));
    expect(await structured(Shape, "sys", fresh(), { cache: false })).toEqual({ n: 1 });
    expect(generateText.mock.calls[1][0].prompt).toContain("YOUR LAST ANSWER WAS INVALID (n:");
  });

  it("gives up after the retries", async () => {
    generateText.mockResolvedValue(reply("not json"));
    await expect(structured(Shape, "sys", fresh(), { cache: false })).rejects.toThrow(/never matched the schema: no JSON object/);
    expect(generateText).toHaveBeenCalledTimes(3);
  });
});
