import { describe, expect, it } from "vitest";
import { isLive, mode, parseJson } from "./llm";

describe("parseJson", () => {
  it("pulls the JSON out of chatty or fenced replies", () => {
    expect(parseJson('Sure! {"a": 1} Hope that helps.')).toEqual({ a: 1 });
    expect(parseJson('```json\n{"a": [1, 2]}\n```')).toEqual({ a: [1, 2] });
    expect(parseJson('<think>maybe {"no": true}</think>{"yes": true}')).toEqual({ yes: true });
  });

  it("keeps a top-level array whole", () => {
    expect(parseJson('[{"a": 1}, {"b": 2}]')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("says what was wrong", () => {
    expect(() => parseJson("")).toThrow("the reply was empty");
    expect(() => parseJson("no json here")).toThrow(/no JSON object/);
    expect(() => parseJson("<think>still thinking")).toThrow("the reply was empty");
  });
});

describe("mode", () => {
  it("runs offline without a key", () => {
    expect(isLive()).toBe(false);
    expect(mode()).toBe("mock");
  });
});
