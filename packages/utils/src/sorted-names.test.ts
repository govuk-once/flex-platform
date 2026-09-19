import { describe, expect, it } from "vitest";

import { sortedNames } from "./sorted-names.ts";

describe("sortedNames", () => {
  it("answers with an array of its own, in order", () => {
    const names = new Set(["second", "first"]);

    expect(sortedNames(names)).toEqual(["first", "second"]);
    expect([...names]).toEqual(["second", "first"]);
  });

  it("takes anything iterable", () => {
    expect(sortedNames(["b", "a"])).toEqual(["a", "b"]);
    expect(sortedNames(new Map([["b", 1]]).keys())).toEqual(["b"]);
  });
});
