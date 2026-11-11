import { assert, describe, expect, it } from "vitest";

import { GatewayError } from "./errors.ts";
import { checkSecureBindings, compileBindings } from "./secure.ts";

const ME = { pairwiseId: "user-me", service: "app" };

function expectMismatch(fn: () => void): GatewayError {
  try {
    fn();
  } catch (err) {
    assert.instanceOf(err, GatewayError);
    expect(err.code).toBe("SECURE_VALUE_MISMATCH");
    return err;
  }
  throw new Error("expected SECURE_VALUE_MISMATCH, nothing was thrown");
}

describe("compileBindings", () => {
  it("returns no bindings when none are configured", () => {
    expect(compileBindings(undefined)).toEqual([]);
    expect(compileBindings({})).toEqual([]);
  });

  it("splits the input path into segments", () => {
    expect(compileBindings({ "user.id": "pairwiseId" })).toEqual([
      { inputPath: "user.id", segments: ["user", "id"], claim: "pairwiseId" },
    ]);
  });

  it("rejects a wildcard path", () => {
    expect(() => compileBindings({ "users.*.id": "pairwiseId" })).toThrow(
      /must not contain a wildcard/,
    );
  });

  it("rejects a malformed path", () => {
    expect(() => compileBindings({ "a..b": "pairwiseId" })).toThrow(
      /Invalid field path/,
    );
  });

  it.each(["", "sub", "constructor", "__proto__"])(
    "rejects %j, which no caller token carries",
    (claim) => {
      expect(() => compileBindings({ userId: claim })).toThrow(
        /must name a caller token claim: pairwiseId/,
      );
    },
  );
});

describe("checkSecureBindings", () => {
  it("passes when there are no bindings", () => {
    expect(() =>
      checkSecureBindings([], { anything: "goes" }, ME),
    ).not.toThrow();
  });

  it("passes when the bound input matches the claim", () => {
    const bindings = compileBindings({ userId: "pairwiseId" });
    expect(() =>
      checkSecureBindings(bindings, { userId: "user-me" }, ME),
    ).not.toThrow();
  });

  it("rejects an input that contradicts the claim", () => {
    const bindings = compileBindings({ userId: "pairwiseId" });
    expectMismatch(() =>
      checkSecureBindings(bindings, { userId: "user-someone-else" }, ME),
    );
  });

  it("rejects an absent bound input rather than passing it", () => {
    const bindings = compileBindings({ userId: "pairwiseId" });
    expectMismatch(() => checkSecureBindings(bindings, {}, ME));
  });

  it("resolves nested input paths, and refuses one that dead-ends", () => {
    const bindings = compileBindings({ "actor.id": "pairwiseId" });
    expect(() =>
      checkSecureBindings(bindings, { actor: { id: "user-me" } }, ME),
    ).not.toThrow();
    expectMismatch(() =>
      checkSecureBindings(bindings, { actor: { id: "other" } }, ME),
    );
    expectMismatch(() =>
      checkSecureBindings(bindings, { actor: "user-me" }, ME),
    );
  });

  it("compares strictly, without coercion", () => {
    const bindings = compileBindings({ userId: "pairwiseId" });
    expectMismatch(() =>
      checkSecureBindings(
        bindings,
        { userId: 1 },
        { pairwiseId: "1", service: "app" },
      ),
    );
  });

  it("checks every binding, not just the first", () => {
    const bindings = compileBindings({
      userId: "pairwiseId",
      "payload.appId": "pairwiseId",
    });
    expectMismatch(() =>
      checkSecureBindings(
        bindings,
        { userId: "user-me", payload: { appId: "other" } },
        ME,
      ),
    );
  });

  it("never names the values in the error message", () => {
    // Diagnostic messages reach logs, so they carry paths and claims only.
    const bindings = compileBindings({ userId: "pairwiseId" });
    const err = expectMismatch(() =>
      checkSecureBindings(
        bindings,
        { userId: "SYNTHETIC_OTHER" },
        { pairwiseId: "SYNTHETIC_ME", service: "app" },
      ),
    );

    expect(err.message).not.toContain("SYNTHETIC");
    expect(err.message).toContain("pairwiseId");
  });
});
