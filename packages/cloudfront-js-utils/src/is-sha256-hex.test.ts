import { describe, expect, it } from "vitest";

import { isSha256Hex } from "./is-sha256-hex.ts";

describe("isSha256Hex", () => {
  it("takes 64 lowercase hex digits", () => {
    expect(isSha256Hex("a".repeat(64))).toBe(true);
  });

  it.each([
    ["uppercase", "A".repeat(64)],
    ["too short", "a".repeat(63)],
    ["too long", "a".repeat(65)],
    ["not hex", "g".repeat(64)],
    ["a line break after it", `${"a".repeat(64)}\n`],
  ])("refuses %s", (_, value) => {
    expect(isSha256Hex(value)).toBe(false);
  });
});
