import { describe, expect, it } from "vitest";

import { isScalar } from "./is-scalar.ts";

describe("isScalar", () => {
  it("accepts what JSON carries as itself", () => {
    expect(isScalar("a")).toBe(true);
    expect(isScalar("")).toBe(true);
    expect(isScalar(0)).toBe(true);
    expect(isScalar(-1.5)).toBe(true);
    expect(isScalar(true)).toBe(true);
    expect(isScalar(false)).toBe(true);
  });

  it("refuses a number JSON cannot write", () => {
    // Each of these serialises as null, so a caller that took them would send, sign or log
    // something other than the value it read.
    expect(isScalar(Number.NaN)).toBe(false);
    expect(isScalar(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isScalar(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it("leaves null to the caller", () => {
    expect(isScalar(null)).toBe(false);
    expect(isScalar(undefined)).toBe(false);
  });

  it("refuses what has parts", () => {
    expect(isScalar({})).toBe(false);
    expect(isScalar([])).toBe(false);
    expect(isScalar(["a"])).toBe(false);
  });
});
