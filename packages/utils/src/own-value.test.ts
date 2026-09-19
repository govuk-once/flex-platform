import { describe, expect, it } from "vitest";

import { ownValue } from "./own-value.ts";

describe("ownValue", () => {
  it("answers with what the record holds", () => {
    expect(ownValue({ a: 1 }, "a")).toBe(1);
    expect(ownValue({ a: undefined }, "a")).toBeUndefined();
  });

  it("answers with nothing for a key the record does not have", () => {
    expect(ownValue<number>({}, "missing")).toBeUndefined();
  });

  it("reads an inherited member as absent", () => {
    // The name arrives from a caller, a schema or a document: without this, an operation called
    // "constructor" would find a function nobody stored.
    expect(ownValue<unknown>({}, "constructor")).toBeUndefined();
    expect(ownValue<unknown>({}, "toString")).toBeUndefined();

    const record: Record<string, number> = Object.create({
      inherited: 1,
    }) as Record<string, number>;
    expect(ownValue(record, "inherited")).toBeUndefined();
  });
});
