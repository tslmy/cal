import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import core from "./routes/core";
import intent from "./routes/intent";
import imports from "./routes/imports";
import learning from "./routes/learning";
import prompts from "./routes/prompts";
import { startMetaLoop } from "./agents/meta";
import { getUser } from "./store";
import type { ChangeSet, Proposal, UserState } from "../src/shared/types";

// The agent server as index.ts builds it, minus the timers, on a free port.
let base = "";
let server: ReturnType<express.Express["listen"]>;
beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.param("user", (_req, res, next, id: string) => (getUser(id) ? next() : res.status(404).json({ error: "no such user" })));
  for (const register of [core, intent, imports, learning, prompts]) register(app);
  startMetaLoop();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function call<T = UserState>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<{ status: number; json: T }> {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as T };
}
const sample = (name: string) => readFileSync(new URL(`../samples/${name}`, import.meta.url), "utf8");

describe("core routes", () => {
  it("lists people and answers 404 for anyone else", async () => {
    const users = await call<{ id: string }[]>("/api/users");
    expect(users.json.map((u) => u.id)).toContain("jordan");
    expect((await call("/api/state/nobody")).status).toBe(404);
    const state = await call<UserState & { mode: string; designing: boolean }>("/api/state/you");
    expect(state.json).toMatchObject({ id: "you", mode: "mock", designing: false });
  });

  it("previews a sentence, applies it and undoes it", async () => {
    await call("/api/state/you/reset", { blank: true });
    expect((await call("/api/intent/you", { text: " " })).status).toBe(400);
    const cs = await call<ChangeSet>("/api/intent/you", { text: "dentist Tuesday 10am" });
    expect(cs.json.ops).toHaveLength(1);
    expect(getUser("you")!.events).toHaveLength(0); // parsing never writes

    expect((await call("/api/changes/you/apply", { ops: [{ op: "nope" }] })).status).toBe(400);
    const applied = await call("/api/changes/you/apply", cs.json);
    expect(applied.json.events.map((e) => e.title)).toEqual(["Dentist"]);
    expect(applied.json.interactions.at(-1)).toMatchObject({ kind: "create", source: "typed" });

    const undone = await call("/api/changes/you/undo", { changeSetId: cs.json.id });
    expect(undone.json.events).toEqual([]);
    expect((await call("/api/changes/you/undo", {})).status).toBe(404);
  });

  it("logs questions as queries", async () => {
    const cs = await call<ChangeSet>("/api/intent/you", { text: "what's on Friday?" });
    expect(cs.json.answer).toBeDefined();
    expect(getUser("you")!.interactions.at(-1)!.kind).toBe("query");
  });

  it("switches views and rejects specs without a root", async () => {
    expect((await call("/api/state/you/view", { spec: { root: "x", elements: {} } })).status).toBe(400);
    const spec = { root: "v", elements: { v: { type: "WeekGrid", props: { weekOf: "2026-10-19", days: ["mon"], startHour: 9, endHour: 17 }, children: [] } } };
    const out = await call("/api/state/you/view", { spec, label: "Week" });
    expect(out.json.spec).toEqual(spec);
    expect(out.json.interactions.at(-1)).toMatchObject({ kind: "view_switch", payload: { label: "Week" } });
  });
});

describe("proposals", () => {
  it("designs, accepts once and reverts, and the meta-learner reacts", async () => {
    await call("/api/state/sam/reset", {});
    const { json } = await call<{ proposal: Proposal }>("/api/design/sam", {});
    expect(json.proposal.title).toBe("Try a view designed for you?");
    const id = json.proposal.id;
    expect((await call(`/api/proposals/sam/${id}/frob`, {})).status).toBe(400);
    expect((await call("/api/proposals/sam/missing/accept", {})).status).toBe(404);

    const accepted = await call(`/api/proposals/sam/${id}/accept`, {});
    expect(accepted.json.spec).toEqual(json.proposal.spec);
    // A second accept is stale and changes nothing.
    const again = await call(`/api/proposals/sam/${id}/accept`, {});
    expect(again.json.interactions.filter((i) => i.kind === "proposal_accepted")).toHaveLength(1);

    const reverted = await call(`/api/proposals/sam/${id}/revert`, {});
    expect(reverted.json.proposals.find((p) => p.id === id)!.status).toBe("undone");
    expect(reverted.json.spec.elements.view.type).toBe("MonthGrid");

    // Undoing an invented view teaches the meta-learner to want fewer of them.
    await vi.waitFor(() => expect(getUser("sam")!.beliefs.some((b) => b.level === "meta")).toBe(true), { timeout: 5000 });
  });

  it("dismisses", async () => {
    const { json } = await call<{ proposal: Proposal }>("/api/design/jordan", {});
    const out = await call(`/api/proposals/jordan/${json.proposal.id}/dismiss`, {});
    expect(out.json.proposals.find((p) => p.id === json.proposal.id)!.status).toBe("dismissed");
  });
});

describe("imports", () => {
  it("imports a calendar file once", async () => {
    await call("/api/state/you/reset", { blank: true });
    expect((await call("/api/import/you/ics", { text: "hello" })).status).toBe(400);
    const first = await call<ChangeSet>("/api/import/you/ics", { text: sample("team-offsite.ics"), name: "team-offsite.ics" });
    expect(first.json.ops.length).toBeGreaterThan(0);
    await call("/api/changes/you/apply", first.json);
    const second = await call<ChangeSet>("/api/import/you/ics", { text: sample("team-offsite.ics") });
    expect(second.json.ops).toEqual([]);
  });

  it("reads emails", async () => {
    expect((await call("/api/import/you/email", { files: [] })).status).toBe(400);
    const out = await call<ChangeSet>("/api/import/you/email", { files: [{ name: "b.eml", text: sample("booking-confirmation.eml") }] });
    expect(out.json.ops[0]).toMatchObject({ op: "create", event: { title: "Stay: Granlibakken Tahoe" } });
  });
});

describe("learning routes", () => {
  it("runs the learner, then deletes a belief", async () => {
    await call("/api/state/jordan/reset", {});
    const ran = await call("/api/learning/jordan/run", {});
    expect(ran.json.learnedThrough).toBe(0);
    const key = ran.json.beliefs[0].key;
    const del = await call(`/api/learning/jordan/beliefs/${key}`, undefined, "DELETE");
    expect(del.json.beliefs.some((b) => b.key === key)).toBe(false);
    expect((await call(`/api/learning/jordan/beliefs/${key}/delete`, {})).status).toBe(404);
  });

  it("validates settings", async () => {
    expect((await call("/api/learning/you/settings", { minGapMinutes: -1 })).status).toBe(400);
    const out = await call("/api/learning/you/settings", { proposalsOn: false, minGapMinutes: 30 });
    expect(out.json.settings).toMatchObject({ proposalsOn: false, minGapMinutes: 30 });
  });

  it("plans a replay as weeks of sentences", async () => {
    expect((await call("/api/learning/replay-plan/nobody")).status).toBe(400);
    const plan = await call<{ weeks: string[][] }>("/api/learning/replay-plan/sam?weeks=3");
    expect(plan.json.weeks).toHaveLength(3);
    expect(plan.json.weeks.flat().length).toBeGreaterThan(0);
  });

  it("replays a sample person into a blank one", async () => {
    const out = await call("/api/learning/sam/replay", { persona: "sam", weeks: 2, delayMs: 0, wait: true });
    expect(out.status).toBe(200);
    expect(getUser("sam")!.interactions.length).toBeGreaterThan(0);
  });
});

describe("prompt routes", () => {
  it("lists versions and validates rollbacks", async () => {
    expect((await call<unknown[]>("/api/prompts/you")).json).toEqual(expect.any(Array));
    expect((await call("/api/prompts/you/robot/rollback", { version: 0 })).status).toBe(400);
    expect((await call("/api/prompts/you/designer/rollback", { version: 9 })).status).toBe(404);
    const out = await call("/api/prompts/you/designer/rollback", { version: 0 });
    expect(out.json.interactions.at(-1)).toMatchObject({ kind: "prompt_rollback", payload: { agent: "designer", version: 0 } });
  });
});
