import { describe, expect, it } from "vitest";

import { stringsIn } from "./strings-in.ts";

describe("stringsIn", () => {
  it("answers with the strings the array holds", () => {
    expect(stringsIn(["a", "b"])).toEqual(["a", "b"]);
  });

  it("leaves out what is not a string", () => {
    expect(stringsIn(["a", 1, null, undefined, {}, ["b"]])).toEqual(["a"]);
  });

  it("answers with nothing for a value that is not an array", () => {
    expect(stringsIn("a")).toEqual([]);
    expect(stringsIn({ 0: "a", length: 1 })).toEqual([]);
    expect(stringsIn(undefined)).toEqual([]);
    expect(stringsIn(null)).toEqual([]);
  });
});
