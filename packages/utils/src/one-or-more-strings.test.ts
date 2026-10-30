import { describe, expect, it } from "vitest";

import { oneOrMoreStrings } from "./one-or-more-strings.ts";

describe("oneOrMoreStrings", () => {
  it("reads one string, or the strings in an array", () => {
    expect(oneOrMoreStrings("a")).toEqual(["a"]);
    expect(oneOrMoreStrings(["a", 1, "b"])).toEqual(["a", "b"]);
    expect(oneOrMoreStrings([])).toEqual([]);
  });

  it("gives undefined for anything else", () => {
    expect(oneOrMoreStrings(undefined)).toBeUndefined();
    expect(oneOrMoreStrings(1)).toBeUndefined();
    expect(oneOrMoreStrings({ 0: "a", length: 1 })).toBeUndefined();
  });
});
