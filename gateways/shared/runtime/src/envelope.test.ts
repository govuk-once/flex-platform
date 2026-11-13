import { assert, describe, expect, it } from "vitest";

import { parseEnvelope } from "./envelope.ts";
import { GatewayError } from "./errors.ts";

const VALID_SECURE = { token: "a.b.c" };

function expectInvalidInput(fn: () => unknown, messagePart: string): void {
  try {
    fn();
    expect.fail("Expected GatewayError to be thrown");
  } catch (err) {
    assert.instanceOf(err, GatewayError);
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toContain(messagePart);
  }
}

describe("parseEnvelope", () => {
  it("parses an envelope with a caller token", () => {
    const req = parseEnvelope({
      operation: "ping",
      input: {},
      secure: VALID_SECURE,
    });
    expect(req.operation).toBe("ping");
    expect(req.input).toEqual({});
    expect(req.secure?.token).toBe("a.b.c");
  });

  it("leaves a missing token to the token step, which refuses it as UNAUTHENTICATED", () => {
    expect(
      parseEnvelope({ operation: "ping", input: {} }).secure,
    ).toBeUndefined();
    expect(
      parseEnvelope({ operation: "ping", input: {}, secure: {} }).secure?.token,
    ).toBeUndefined();
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

  it("rejects non-object secure block", () => {
    expectInvalidInput(
      () => parseEnvelope({ operation: "ping", input: {}, secure: "bad" }),
      "secure",
    );
  });

  it("rejects a token that isn't a string", () => {
    expectInvalidInput(
      () =>
        parseEnvelope({ operation: "ping", input: {}, secure: { token: 123 } }),
      "secure.token",
    );
  });
});
