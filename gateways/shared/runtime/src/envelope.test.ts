import { describe, expect, it } from "vitest";

import { parseEnvelope } from "./envelope.ts";
import { GatewayError } from "./errors.ts";

const VALID_SECURE = { values: {}, signature: "" };

function expectInvalidInput(fn: () => unknown, messagePart: string): void {
  try {
    fn();
    expect.fail("Expected GatewayError to be thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("INVALID_INPUT");
    expect((err as GatewayError).message).toContain(messagePart);
  }
}

describe("parseEnvelope", () => {
  it("parses a minimal valid envelope", () => {
    const req = parseEnvelope({
      operation: "ping",
      input: {},
      secure: VALID_SECURE,
    });
    expect(req.operation).toBe("ping");
    expect(req.input).toEqual({});
    expect(req.secure.values).toEqual({});
  });

  it("parses an envelope with populated secure block", () => {
    const req = parseEnvelope({
      operation: "transfer",
      input: { amount: 100 },
      secure: { values: { userId: "abc" }, signature: "sig123" },
    });
    expect(req.operation).toBe("transfer");
    expect(req.secure.values).toEqual({ userId: "abc" });
    expect(req.secure.signature).toBe("sig123");
  });

  it("rejects input: null", () => {
    expectInvalidInput(
      () =>
        parseEnvelope({ operation: "ping", input: null, secure: VALID_SECURE }),
      "input",
    );
  });

  it("rejects null event", () => {
    expectInvalidInput(() => parseEnvelope(null), "JSON object");
  });

  it("rejects string event", () => {
    expectInvalidInput(() => parseEnvelope("hello"), "JSON object");
  });

  it("rejects number event", () => {
    expectInvalidInput(() => parseEnvelope(42), "JSON object");
  });

  it("rejects array event", () => {
    expectInvalidInput(() => parseEnvelope([1, 2]), "JSON object");
  });

  it("rejects missing operation", () => {
    expectInvalidInput(
      () => parseEnvelope({ input: {}, secure: VALID_SECURE }),
      "operation",
    );
  });

  it("rejects non-string operation", () => {
    expectInvalidInput(
      () => parseEnvelope({ operation: 123, input: {}, secure: VALID_SECURE }),
      "operation",
    );
  });

  it("rejects empty string operation", () => {
    expectInvalidInput(
      () => parseEnvelope({ operation: "", input: {}, secure: VALID_SECURE }),
      "operation",
    );
  });

  it("rejects missing input key", () => {
    expectInvalidInput(
      () => parseEnvelope({ operation: "ping", secure: VALID_SECURE }),
      "input",
    );
  });

  it("rejects missing secure block", () => {
    expectInvalidInput(
      () => parseEnvelope({ operation: "ping", input: {} }),
      "secure",
    );
  });

  it("rejects non-object secure block", () => {
    expectInvalidInput(
      () => parseEnvelope({ operation: "ping", input: {}, secure: "bad" }),
      "secure",
    );
  });

  it("rejects secure with missing values", () => {
    expectInvalidInput(
      () =>
        parseEnvelope({
          operation: "ping",
          input: {},
          secure: { signature: "sig" },
        }),
      "secure.values",
    );
  });

  it("rejects secure with missing signature", () => {
    expectInvalidInput(
      () =>
        parseEnvelope({
          operation: "ping",
          input: {},
          secure: { values: { a: 1 } },
        }),
      "secure.signature",
    );
  });

  it("rejects secure with non-string signature", () => {
    expectInvalidInput(
      () =>
        parseEnvelope({
          operation: "ping",
          input: {},
          secure: { values: { a: 1 }, signature: 123 },
        }),
      "secure.signature",
    );
  });
});

describe("parseEnvelope: secure.values must be scalars", () => {
  const withValues = (values: unknown) => ({
    operation: "op",
    input: {},
    secure: { values, signature: "sig" },
  });

  it.each([
    ["string", "abc"],
    ["number", 42],
    ["zero", 0],
    ["boolean", true],
    ["null", null],
  ])("accepts a %s value", (_label, value) => {
    expect(() => parseEnvelope(withValues({ k: value }))).not.toThrow();
  });

  it.each([
    ["nested object", { nested: { a: 1 } }],
    ["array", { list: [1, 2] }],
    ["undefined", { k: undefined }],
  ])("rejects a %s value as INVALID_INPUT", (_label, values) => {
    try {
      parseEnvelope(withValues(values));
      throw new Error("expected INVALID_INPUT");
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).code).toBe("INVALID_INPUT");
    }
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s, which would stringify to null when signed", (_l, value) => {
    expect(() => parseEnvelope(withValues({ k: value }))).toThrow(
      /secure.values.k/,
    );
  });

  it("names the offending key in the message", () => {
    expect(() => parseEnvelope(withValues({ ok: 1, bad: {} }))).toThrow(
      /secure\.values\.bad/,
    );
  });
});
