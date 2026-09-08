import { describe, expect, it } from "vitest";

import { ERROR_CODES, GatewayError, type SignalRuling } from "./errors.ts";

const VALID_RULINGS: ReadonlySet<SignalRuling> = new Set([
  "none",
  "trust",
  "upstream_failure",
  "upstream_success",
  "unhandled",
]);

describe("ERROR_CODES", () => {
  it("every code has a valid signal ruling", () => {
    for (const [code, meta] of Object.entries(ERROR_CODES)) {
      expect(
        VALID_RULINGS.has(meta.signal),
        `${code} has invalid signal ruling: ${meta.signal}`,
      ).toBe(true);
    }
  });

  it("NOT_FOUND counts as upstream success", () => {
    expect(ERROR_CODES.NOT_FOUND.signal).toBe("upstream_success");
  });

  it("UPSTREAM_REJECTED counts as upstream success", () => {
    expect(ERROR_CODES.UPSTREAM_REJECTED.signal).toBe("upstream_success");
  });

  it("UPSTREAM_CONTRACT_VIOLATION counts as upstream failure", () => {
    expect(ERROR_CODES.UPSTREAM_CONTRACT_VIOLATION.signal).toBe(
      "upstream_failure",
    );
  });

  it("UPSTREAM_TIMEOUT counts as upstream failure", () => {
    expect(ERROR_CODES.UPSTREAM_TIMEOUT.signal).toBe("upstream_failure");
  });

  it("secure codes are trust issues", () => {
    expect(ERROR_CODES.SECURE_VALUE_MISMATCH.signal).toBe("trust");
    expect(ERROR_CODES.SECURE_SIGNATURE_INVALID.signal).toBe("trust");
  });

  it("INTERNAL is unhandled", () => {
    expect(ERROR_CODES.INTERNAL.signal).toBe("unhandled");
  });

  it("pre-pipeline codes have no upstream signal", () => {
    expect(ERROR_CODES.INVALID_INPUT.signal).toBe("none");
    expect(ERROR_CODES.OPERATION_NOT_FOUND.signal).toBe("none");
  });
});

describe("GatewayError", () => {
  it("carries code and message", () => {
    const err = new GatewayError("INVALID_INPUT", "bad input");
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toBe("bad input");
    expect(err.name).toBe("GatewayError");
  });

  it("is an instance of Error", () => {
    const err = new GatewayError("INTERNAL", "boom");
    expect(err).toBeInstanceOf(Error);
  });
});
