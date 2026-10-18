import { describe, expect, it } from "vitest";
import { design, systemPrompt } from "./designer";
import { mockDraft } from "./mock";
import { DAY_ONE } from "./store";
import { isNovel, type CalendarSpec } from "../src/shared/catalog";
import { critique } from "../src/shared/critic";
import { PERSONAS } from "../src/shared/personas";
import type { DesignRequest, Persona } from "../src/shared/types";

const persona = (id: string) => PERSONAS.find((p) => p.id === id)!;
const req = (currentSpec: CalendarSpec = DAY_ONE, history: DesignRequest["history"] = []): DesignRequest => ({ personaId: "x", currentSpec, history });
type Out = { proposal: { title: string; reason: string; spec: CalendarSpec } | null; why?: string };

describe("systemPrompt", () => {
  it("lists the catalog's components and the output shape", () => {
    const s = systemPrompt();
    expect(s).toContain("AVAILABLE COMPONENTS");
    expect(s).toContain("YearBand");
    expect(s).not.toContain("AVAILABLE ACTIONS");
    expect(s).toMatch(/RULES:\n1\. /);
  });
});

describe("design (offline)", () => {
  it.each([
    ["jordan", "Make the week your default view?"],
    ["mina", "Show your plans by year?"],
    ["sam", "Try a view designed for you?"],
  ])("proposes a view for %s that passes the critic", async (id, title) => {
    const p = persona(id);
    const out = await design(p, req());
    expect(out.mode).toBe("mock");
    expect(out.proposal!.title).toBe(title);
    expect(critique(out.proposal!.spec, p.events, DAY_ONE).ok).toBe(true);
    expect(out.trace[0].text).toMatch(/offline mock/);
  });

  it("repairs flawed first drafts", async () => {
    const out = await design(persona("mina"), req());
    expect(out.trace.some((t) => t.role === "Critic" || /fail|reject|repair/i.test(t.text))).toBe(true);
  });

  it("keeps the current view when it already fits", async () => {
    const yearBand: CalendarSpec = { root: "v", elements: { v: { type: "YearBand", props: { from: 2026, to: 2030, labels: "calendar" }, children: [] } } };
    const out = await design(persona("mina"), req(yearBand));
    expect(out.proposal).toBeNull();
    expect(out.trace.at(-1)!.text).toBe("Nothing to suggest right now.");
  });

  it("has nothing to say about someone it knows nothing about", async () => {
    const blank: Persona = { id: "new", name: "New", role: "", profile: { facts: [], signals: {}, confidence: 0 }, events: [] };
    expect((await design(blank, req())).proposal).toBeNull();
  });
});

describe("mockDraft", () => {
  it("hides weekends once the week view is in", () => {
    const week: CalendarSpec = { root: "v", elements: { v: { type: "WeekGrid", props: { weekOf: "2026-10-19", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], startHour: 9, endHour: 17 }, children: [] } } };
    const out = mockDraft(persona("jordan"), req(week), 0, 1) as Out;
    expect(out.proposal!.title).toBe("Hide weekends?");
    expect(out.proposal!.spec.elements.view.props.days).toEqual(["mon", "tue", "wed", "thu", "fri"]);
  });

  it("sticks to month grids when novelty appetite is low", () => {
    const out = mockDraft(persona("sam"), req(), 0, 1, "novelty appetite: low") as Out;
    expect(isNovel(out.proposal!.spec)).toBe(false);
    expect(out.proposal!.reason).toMatch(/plain month grids/);
  });

  it("tries another script after a view was turned down", () => {
    const first = mockDraft(persona("sam"), req(), 0, 1) as Out;
    const next = mockDraft(persona("sam"), req(DAY_ONE, [{ title: first.proposal!.title, status: "undone" }]), 0, 1) as Out;
    expect(next.proposal!.title).not.toBe(first.proposal!.title);
  });

  it("picks a script from learned signals for anyone else", () => {
    const base: Persona = { id: "x", name: "X", role: "", profile: { facts: ["Works nights past midnight"], signals: {}, confidence: 0.8 }, events: [] };
    const nights = mockDraft({ ...base, profile: { ...base.profile, signals: { overnight: 19 } } }, req(), 0, 0) as Out;
    expect(nights.proposal!.title).toBe("Show whole days, midnight to midnight?");
    const rotation = mockDraft({ ...base, profile: { ...base.profile, signals: { rotation: true } } }, req(), 0, 0) as Out;
    expect(rotation.proposal!.title).toBe("Show this week and next together?");
  });
});
