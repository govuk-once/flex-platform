import { describe, expect, it } from "vitest";

import { checkSecureBindings, prepareSecurePayload } from "./secure.ts";

describe("prepareSecurePayload", () => {
  it("produces identical output regardless of insertion order", () => {
    const a = prepareSecurePayload({ b: 2, a: 1, c: 3 });
    const b = prepareSecurePayload({ c: 3, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("returns empty object JSON for empty values", () => {
    expect(prepareSecurePayload({})).toBe("{}");
  });

  it("strips undefined values", () => {
    const result = prepareSecurePayload({ a: 1, b: undefined, c: 3 });
    expect(JSON.parse(result)).toEqual({ a: 1, c: 3 });
  });

  it("preserves value types", () => {
    const result = prepareSecurePayload({
      str: "hello",
      num: 42,
      bool: true,
      nil: null,
    });
    expect(JSON.parse(result)).toEqual({
      bool: true,
      nil: null,
      num: 42,
      str: "hello",
    });
  });
});

describe("checkSecureBindings", () => {
  it("does not throw (stub behaviour)", () => {
    expect(() =>
      checkSecureBindings({ userId: "abc" }, "sig123"),
    ).not.toThrow();
  });
});
