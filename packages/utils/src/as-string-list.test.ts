import { describe, expect, it } from "vitest";

import { asStringList } from "./as-string-list.ts";

describe("asStringList", () => {
  it("reads one string, or the strings in an array", () => {
    expect(asStringList("a")).toEqual(["a"]);
    expect(asStringList(["a", 1, "b"])).toEqual(["a", "b"]);
  });

  it("gives an empty list for an array with no strings, unlike a value left out", () => {
    expect(asStringList([])).toEqual([]);
    expect(asStringList([1])).toEqual([]);
  });

  it("gives undefined for anything else", () => {
    expect(asStringList(undefined)).toBeUndefined();
    expect(asStringList(1)).toBeUndefined();
    expect(asStringList({ 0: "a", length: 1 })).toBeUndefined();
  });
});
