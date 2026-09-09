import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  EnvelopeError,
  EnvelopeResponse,
  EnvelopeSuccess,
} from "./envelope.ts";
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

describe("EnvelopeResponse type narrowing", () => {
  it("narrows success envelope on ok: true", () => {
    const resp: EnvelopeResponse = {
      ok: true,
      outcome: "created",
      data: { id: "1" },
    };
    if (resp.ok) {
      expectTypeOf(resp).toExtend<EnvelopeSuccess>();
      expect(resp.outcome).toBe("created");
    }
  });

  it("narrows error envelope on ok: false", () => {
    const resp: EnvelopeResponse = {
      ok: false,
      error: { code: "INTERNAL", message: "boom" },
    };
    if (!resp.ok) {
      expectTypeOf(resp).toExtend<EnvelopeError>();
      expect(resp.error.code).toBe("INTERNAL");
    }
  });
});
