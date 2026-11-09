import { describe, expect, it } from "vitest";

import { heldValue } from "./held-value.ts";

describe("heldValue", () => {
  it("answers with what the map holds", () => {
    expect(heldValue(new Map([["a", 1]]), "a")).toBe(1);
    expect(heldValue(new Map([["a", undefined]]), "a")).toBeUndefined();
  });

  it("throws for a key the map does not hold", () => {
    expect(() => heldValue(new Map<string, number>(), "missing")).toThrow(
      "Nothing is held under missing",
    );
  });
});
