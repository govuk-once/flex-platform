import { describe, expect, it } from "vitest";

import { isRecord } from "./is-record.ts";

describe("isRecord", () => {
  it("accepts what can be read by name", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it("refuses what cannot", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("a")).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(() => undefined)).toBe(false);
  });
});
