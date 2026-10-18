import { describe, expect, it } from "vitest";
import { activity, addActivity, DAY_ONE, getUser, listUsers, log, newId, onInteraction, resetUser, update } from "./store";
import { personaOf } from "./profile";
import { activePrompt, learnedSection, promptVersionsUsed, systemFor, withLearned } from "./prompts";
import type { PromptVersion } from "../src/shared/types";

describe("store", () => {
  it("seeds every sample person", () => {
    const ids = listUsers().map((u) => u.id);
    expect(ids).toEqual(expect.arrayContaining(["you", "mina", "jordan", "sam", "rosa", "dev", "priya"]));
    expect(getUser("you")!.spec).toEqual(DAY_ONE);
    expect(getUser("sam")!.beliefs[0].key).toBe("seed.0");
    // Tailored demo people start in the view the designer proposed for them.
    expect(getUser("rosa")!.proposals[0]).toMatchObject({ status: "accepted", previous: DAY_ONE });
  });

  it("makes unique ids", () => {
    expect(newId("x")).not.toBe(newId("x"));
  });

  it("drops a write made against a state that was since reset", async () => {
    const before = getUser("sam")!;
    await resetUser("sam");
    expect(await update("sam", () => "late", before)).toBeUndefined();
    expect(await update("sam", () => "now")).toBe("now");
    await expect(update("nobody", () => 0)).rejects.toThrow("no such user");
    await expect(resetUser("nobody")).rejects.toThrow("no such user");
  });

  it("blanks a person but keeps who they are", async () => {
    await resetUser("sam", true);
    expect(getUser("sam")).toMatchObject({ id: "sam", name: "Sam", events: [], beliefs: [] });
    await resetUser("sam");
    expect(getUser("sam")!.events.length).toBeGreaterThan(0);
  });

  it("logs interactions and tells listeners, even if one fails", async () => {
    const seen: string[] = [];
    onInteraction(() => {
      throw new Error("boom");
    });
    onInteraction((user, i) => seen.push(`${user}:${i.kind}`));
    const i = await log("you", "query", { q: 1 }, "typed");
    expect(getUser("you")!.interactions.at(-1)).toEqual(i);
    expect(seen).toContain("you:query");
  });

  it("caps the activity feed", async () => {
    const s = getUser("you")!;
    for (let n = 0; n < 305; n++) activity(s, "Test", `line ${n}`);
    expect(s.activity).toHaveLength(300);
    await addActivity("you", [{ role: "Test", text: "last", diff: "+x" }]);
    expect(getUser("you")!.activity.at(-1)).toMatchObject({ text: "last", diff: "+x" });
  });
});

describe("personaOf", () => {
  it("hands the designer only confident habits", () => {
    const s = { ...getUser("you")!, beliefs: [
      { key: "weekendEvents", statement: "No weekends", value: false, confidence: 0.8, evidence: [], level: "habit" as const, updatedAt: "" },
      { key: "workHours", statement: "9 to 5", value: "9-17", confidence: 0.3, evidence: [], level: "habit" as const, updatedAt: "" },
      { key: "seed.0", statement: "Seeded", value: true, confidence: 0.6, evidence: [], level: "habit" as const, updatedAt: "" },
    ] };
    const p = personaOf(s);
    expect(p.profile.facts).toEqual(["No weekends (confidence 0.80)", "Seeded (confidence 0.60)"]);
    expect(p.profile.signals).toEqual({ weekendEvents: false });
    expect(p.profile.confidence).toBe(0.8);
    expect(personaOf({ ...s, beliefs: [] }).profile.confidence).toBe(0);
  });
});

describe("prompts", () => {
  const v = (agent: PromptVersion["agent"], version: number, active: boolean, learned: string) => ({ agent, version, active, learned }) as PromptVersion;
  const s = { ...getUser("you")!, prompts: [v("designer", 1, false, "old"), v("designer", 2, true, " Likes weeks. "), v("intent", 1, true, "")] };

  it("adds the learned section after the core", () => {
    expect(activePrompt(s, "designer")!.version).toBe(2);
    expect(learnedSection(s, "designer")).toBe("Likes weeks.");
    expect(systemFor("CORE", s, "designer")).toBe("CORE\n\nABOUT THIS PERSON (learned; follow it unless it conflicts with the rules above):\nLikes weeks.");
    expect(systemFor("CORE", s, "intent")).toBe("CORE");
    expect(withLearned("CORE", "")).toBe("CORE");
    expect(promptVersionsUsed(s)).toEqual({ designer: 2, intent: 1 });
  });
});
