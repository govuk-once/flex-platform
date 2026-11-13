import { describe, expect, it } from "vitest";

import { isRepeated } from "./repeated.ts";

describe("isRepeated", () => {
  it.each([
    ["a missing field", undefined],
    ["a field with one value", { value: "a" }],
    [
      "a field listing its one value",
      { value: "a", multiValue: [{ value: "a" }] },
    ],
    ["a field listing no value", { value: "", multiValue: [] }],
  ])("is false for %s", (_, field) => {
    expect(isRepeated(field)).toBe(false);
  });

  it("is true for a field sent more than once, even with the same value", () => {
    expect(
      isRepeated({ value: "a", multiValue: [{ value: "a" }, { value: "b" }] }),
    ).toBe(true);
    expect(
      isRepeated({ value: "a", multiValue: [{ value: "a" }, { value: "a" }] }),
    ).toBe(true);
  });
});
