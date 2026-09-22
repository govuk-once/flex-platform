import { describe, expect, it } from "vitest";

import { byCodeUnit } from "./by-code-unit.ts";

describe("byCodeUnit", () => {
  it("orders by code unit rather than by locale", () => {
    // Every locale reads these differently: "Ärger" lands beside "apple" in German and after
    // "Zebra" in Swedish. Code units put the capitals first, then the underscore, then the
    // lower-case names, then the accented one, the same way on every machine.
    expect(
      ["Zebra", "apple", "Ärger", "banana", "_private"].sort(byCodeUnit),
    ).toEqual(["Zebra", "_private", "apple", "banana", "Ärger"]);
  });

  it("answers zero only for strings that are the same", () => {
    // A comparator that calls distinct strings equal leaves them in insertion order, which is
    // what sorting is here to remove.
    expect(byCodeUnit("a", "a")).toBe(0);
    expect(byCodeUnit("a", "A")).toBeGreaterThan(0);
    expect(byCodeUnit("A", "a")).toBeLessThan(0);
    expect(byCodeUnit("ä", "a")).toBeGreaterThan(0);
  });
});
