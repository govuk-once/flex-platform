import { describe, expect, it } from "vitest";

import { sortedEntries } from "./sorted-entries.ts";

describe("sortedEntries", () => {
  it("answers a record's entries by key, whatever order they were written in", () => {
    expect(sortedEntries({ second: 2, first: 1 })).toEqual([
      ["first", 1],
      ["second", 2],
    ]);
  });

  it("reads the record's own keys only", () => {
    // Inherited members are not entries of the record, and a name from a prototype is not one a
    // caller wrote.
    const record: Record<string, number> = Object.create({
      inherited: 1,
    }) as Record<string, number>;
    record["own"] = 2;

    expect(sortedEntries(record)).toEqual([["own", 2]]);
  });

  it("keeps a value the record holds under a key, undefined included", () => {
    expect(sortedEntries<number | undefined>({ a: undefined })).toEqual([
      ["a", undefined],
    ]);
  });
});
