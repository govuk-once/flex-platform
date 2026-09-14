import type { SecureValue } from "@repo/gateway-types";
import { describe, expect, it } from "vitest";

import { GatewayError } from "./errors.ts";
import {
  checkSecureBindings,
  compileBindings,
  prepareSecurePayload,
} from "./secure.ts";

const NO_SIG = "";

function expectMismatch(fn: () => void): GatewayError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("SECURE_VALUE_MISMATCH");
    return err as GatewayError;
  }
  throw new Error("expected SECURE_VALUE_MISMATCH, nothing was thrown");
}

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
    const values = { a: 1, b: undefined, c: 3 } as unknown as Record<
      string,
      SecureValue
    >;
    expect(JSON.parse(prepareSecurePayload(values))).toEqual({ a: 1, c: 3 });
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

  it("sorts numeric-like keys deterministically", () => {
    // JS reorders integer-like keys on iteration, so these two objects enumerate the same way
    // regardless of how they were written. Sorting must still produce one canonical string.
    expect(prepareSecurePayload({ "10": "a", "2": "b" })).toBe(
      prepareSecurePayload({ "2": "b", "10": "a" }),
    );
  });
});

describe("compileBindings", () => {
  it("returns no bindings when none are configured", () => {
    expect(compileBindings(undefined)).toEqual([]);
    expect(compileBindings({})).toEqual([]);
  });

  it("splits the input path into segments", () => {
    expect(compileBindings({ "user.id": "sub" })).toEqual([
      { inputPath: "user.id", segments: ["user", "id"], secureKey: "sub" },
    ]);
  });

  it("rejects a wildcard path", () => {
    expect(() => compileBindings({ "users.*.id": "sub" })).toThrow(
      /must not contain a wildcard/,
    );
  });

  it("rejects a malformed path", () => {
    expect(() => compileBindings({ "a..b": "sub" })).toThrow(
      /Invalid field path/,
    );
  });

  it("rejects an empty secure key", () => {
    expect(() => compileBindings({ userId: "" })).toThrow(
      /non-empty secure value key/,
    );
  });
});

describe("checkSecureBindings", () => {
  it("passes when there are no bindings", () => {
    expect(() =>
      checkSecureBindings([], { anything: "goes" }, { sub: "me" }, NO_SIG),
    ).not.toThrow();
  });

  it("passes when the bound input matches the secure value", () => {
    const bindings = compileBindings({ userId: "sub" });
    expect(() =>
      checkSecureBindings(
        bindings,
        { userId: "user-me" },
        { sub: "user-me" },
        NO_SIG,
      ),
    ).not.toThrow();
  });

  it("rejects an input that contradicts the secure value", () => {
    // Binding checks reject contradictory identifiers independently of signature verification.
    const bindings = compileBindings({ userId: "sub" });
    expectMismatch(() =>
      checkSecureBindings(
        bindings,
        { userId: "user-someone-else" },
        { sub: "user-me" },
        NO_SIG,
      ),
    );
  });

  it("rejects an absent bound input rather than passing it", () => {
    const bindings = compileBindings({ userId: "sub" });
    expectMismatch(() =>
      checkSecureBindings(bindings, {}, { sub: "user-me" }, NO_SIG),
    );
  });

  it("rejects a secure value missing from the envelope", () => {
    const bindings = compileBindings({ userId: "sub" });
    expectMismatch(() =>
      checkSecureBindings(bindings, { userId: "user-me" }, {}, NO_SIG),
    );
  });

  it("resolves nested input paths", () => {
    const bindings = compileBindings({ "actor.id": "sub" });
    expect(() =>
      checkSecureBindings(
        bindings,
        { actor: { id: "user-me" } },
        { sub: "user-me" },
        NO_SIG,
      ),
    ).not.toThrow();

    expectMismatch(() =>
      checkSecureBindings(
        bindings,
        { actor: { id: "other" } },
        { sub: "user-me" },
        NO_SIG,
      ),
    );
  });

  it("rejects a nested path that dead-ends on a non-object", () => {
    const bindings = compileBindings({ "actor.id": "sub" });
    expectMismatch(() =>
      checkSecureBindings(
        bindings,
        { actor: "user-me" },
        { sub: "user-me" },
        NO_SIG,
      ),
    );
  });

  it("compares strictly, without coercion", () => {
    const bindings = compileBindings({ tenantId: "tenant" });
    expectMismatch(() =>
      checkSecureBindings(bindings, { tenantId: "1" }, { tenant: 1 }, NO_SIG),
    );
    expect(() =>
      checkSecureBindings(bindings, { tenantId: 1 }, { tenant: 1 }, NO_SIG),
    ).not.toThrow();
  });

  it("matches boolean and null secure values", () => {
    const bindings = compileBindings({ verified: "verified", org: "org" });
    expect(() =>
      checkSecureBindings(
        bindings,
        { verified: true, org: null },
        { verified: true, org: null },
        NO_SIG,
      ),
    ).not.toThrow();

    expectMismatch(() =>
      checkSecureBindings(
        bindings,
        { verified: false, org: null },
        { verified: true, org: null },
        NO_SIG,
      ),
    );
  });

  it("checks every binding, not just the first", () => {
    const bindings = compileBindings({ userId: "sub", tenantId: "tenant" });
    expectMismatch(() =>
      checkSecureBindings(
        bindings,
        { userId: "user-me", tenantId: "other-tenant" },
        { sub: "user-me", tenant: "my-tenant" },
        NO_SIG,
      ),
    );
  });

  it("never names the values in the error message", () => {
    // Diagnostic messages reach logs, so they must carry paths and keys only.
    const bindings = compileBindings({ nino: "nino" });
    const err = expectMismatch(() =>
      checkSecureBindings(
        bindings,
        { nino: "QQ123456C" },
        { nino: "AB987654D" },
        NO_SIG,
      ),
    );

    expect(err.message).not.toContain("QQ123456C");
    expect(err.message).not.toContain("AB987654D");
    expect(err.message).toContain("nino");
  });
});
