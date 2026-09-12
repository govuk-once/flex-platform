import { defineGateway } from "@repo/gateway-config";
import type {
  EnvelopeError,
  EnvelopeInbound,
  EnvelopeSuccess,
  Validator,
} from "@repo/gateway-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DriverContext } from "./context.ts";
import { GatewayError } from "./errors.ts";
import type { AnyGatewayConfig, HandlerDeps } from "./handler.ts";
import { createHandler } from "./handler.ts";

// -- Helpers ------------------------------------------------------------------

const VALID_SECURE = { values: {}, signature: "" };

const alwaysValid: Validator = Object.assign(
  (_data: unknown): _data is unknown => true,
  { errors: null },
);

const alwaysInvalid: Validator = Object.assign(
  (_data: unknown): _data is never => false,
  {
    errors: [
      {
        instancePath: "/bad",
        schemaPath: "#/bad",
        message: "always fails",
      },
    ],
  },
);

const stubExecute: HandlerDeps["execute"] = () =>
  Promise.resolve({ outcome: "success", data: { id: "123" } });

function testConfig(
  overrides: Partial<{
    operations: Record<
      string,
      {
        description?: string;
        log?: { input?: string[]; output?: string[] };
      }
    >;
  }> = {},
): AnyGatewayConfig {
  return defineGateway({
    id: "test-gw",
    driver: { type: "stub" },
    operations: overrides.operations ?? {
      ping: { description: "Test operation" },
    },
  });
}

const NO_DEADLINE = { remainingMs: () => Infinity };

function testDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    validators: {
      ping: { input: alwaysValid, outcomes: { success: alwaysValid } },
    },
    execute: stubExecute,
    deadline: NO_DEADLINE,
    ...overrides,
  };
}

function envelope(
  overrides: Partial<
    Pick<EnvelopeInbound, "operation" | "input" | "secure">
  > = {},
) {
  return {
    operation: "ping",
    input: {},
    secure: VALID_SECURE,
    ...overrides,
  };
}

// -- Stdout capture -----------------------------------------------------------

let stdoutChunks: string[];

beforeEach(() => {
  stdoutChunks = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdoutChunks.push(
      typeof chunk === "string" ? chunk : (chunk as Buffer).toString(),
    );
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function capturedOutput(): string {
  return stdoutChunks.join("");
}

// -- Tests --------------------------------------------------------------------

describe("createHandler", () => {
  describe("happy path", () => {
    it("returns success envelope for valid input", async () => {
      const handler = createHandler(testConfig(), testDeps());
      const resp = await handler(envelope({ input: { msg: "hello" } }));

      expect(resp.ok).toBe(true);
      const success = resp as EnvelopeSuccess;
      expect(success.outcome).toBe("success");
      expect(success.data).toEqual({ id: "123" });
    });
  });

  describe("step 3: route on operation", () => {
    it("returns OPERATION_NOT_FOUND for unknown operation", async () => {
      const handler = createHandler(testConfig(), testDeps());
      const resp = await handler(envelope({ operation: "unknown" }));

      expect(resp.ok).toBe(false);
      const err = resp as EnvelopeError;
      expect(err.error.code).toBe("OPERATION_NOT_FOUND");
      expect(capturedOutput()).toContain("unknown");
    });
  });

  describe("step 4: validate input", () => {
    it("returns INVALID_INPUT when validation fails", async () => {
      const handler = createHandler(
        testConfig(),
        testDeps({
          validators: {
            ping: {
              input: alwaysInvalid,
              outcomes: { success: alwaysValid },
            },
          },
        }),
      );
      const resp = await handler(envelope({ input: { bad: true } }));

      expect(resp.ok).toBe(false);
      const err = resp as EnvelopeError;
      expect(err.error.code).toBe("INVALID_INPUT");
      expect(capturedOutput()).toContain("always fails");
    });

    it("does not call execute when input is invalid", async () => {
      const execute = vi.fn(stubExecute);
      const handler = createHandler(
        testConfig(),
        testDeps({
          validators: {
            ping: {
              input: alwaysInvalid,
              outcomes: { success: alwaysValid },
            },
          },
          execute,
        }),
      );

      await handler(envelope());
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe("step 5: secure bindings", () => {
    it("accepts envelopes with populated secure block", async () => {
      const handler = createHandler(testConfig(), testDeps());
      const resp = await handler(
        envelope({
          secure: { values: { userId: "abc" }, signature: "sig" },
        }),
      );

      expect(resp.ok).toBe(true);
    });
  });

  describe("step 6: derive deadline", () => {
    it("applies safety margin to Lambda remaining time", async () => {
      const handler = createHandler(
        testConfig(),
        testDeps({
          deadline: { remainingMs: () => 600 },
          execute: async (ctx) => {
            await ctx.attempt(
              () => new Promise((resolve) => setTimeout(resolve, 5_000)),
            );
            return { outcome: "success", data: {} };
          },
        }),
      );
      const resp = await handler(envelope());

      expect(resp.ok).toBe(false);
      expect((resp as EnvelopeError).error.code).toBe("UPSTREAM_TIMEOUT");
    });

    it("uses policy timeout when deadline has no constraint", async () => {
      const handler = createHandler(testConfig(), testDeps());
      const resp = await handler(envelope());

      expect(resp.ok).toBe(true);
    });
  });

  describe("step 7: run pipeline", () => {
    it("passes a working DriverContext to execute", async () => {
      const execute: HandlerDeps["execute"] = vi.fn(
        async (ctx: DriverContext) => {
          const result = await ctx.attempt((_signal) =>
            Promise.resolve({
              outcome: "created" as const,
              data: { id: "456" },
            }),
          );
          return result;
        },
      );
      const handler = createHandler(
        testConfig(),
        testDeps({
          validators: {
            ping: {
              input: alwaysValid,
              outcomes: { created: alwaysValid },
            },
          },
          execute,
        }),
      );

      const resp = await handler(envelope());
      expect(resp.ok).toBe(true);
      expect((resp as EnvelopeSuccess).data).toEqual({ id: "456" });
      expect(execute).toHaveBeenCalledOnce();
      const [ctx, operation, input] = vi.mocked(execute).mock.calls[0]!;
      expect(ctx).toHaveProperty("attempt");
      expect(operation).toBe("ping");
      expect(input).toEqual({});
    });

    it("passes correct operation and input to execute", async () => {
      const execute = vi.fn(stubExecute);
      const handler = createHandler(testConfig(), testDeps({ execute }));

      await handler(envelope({ input: { key: "value" } }));
      expect(execute).toHaveBeenCalledOnce();
      const [, operation, input] = vi.mocked(execute).mock.calls[0]!;
      expect(operation).toBe("ping");
      expect(input).toEqual({ key: "value" });
    });
  });

  describe("step 8: validate outcome", () => {
    it("returns UPSTREAM_CONTRACT_VIOLATION for unknown outcome name", async () => {
      const handler = createHandler(
        testConfig(),
        testDeps({
          execute: () => Promise.resolve({ outcome: "nonexistent", data: {} }),
        }),
      );
      const resp = await handler(envelope());

      expect(resp.ok).toBe(false);
      const err = resp as EnvelopeError;
      expect(err.error.code).toBe("UPSTREAM_CONTRACT_VIOLATION");
      expect(capturedOutput()).toContain("nonexistent");
    });

    it("returns UPSTREAM_CONTRACT_VIOLATION when outcome data fails validation", async () => {
      const handler = createHandler(
        testConfig(),
        testDeps({
          validators: {
            ping: {
              input: alwaysValid,
              outcomes: { success: alwaysInvalid },
            },
          },
        }),
      );
      const resp = await handler(envelope());

      expect(resp.ok).toBe(false);
      const err = resp as EnvelopeError;
      expect(err.error.code).toBe("UPSTREAM_CONTRACT_VIOLATION");
    });
  });

  describe("step 9: record health", () => {
    it("records upstream_success signal on success", async () => {
      const handler = createHandler(testConfig(), testDeps());
      await handler(envelope());

      const output = capturedOutput();
      expect(output).toContain('"signal":"upstream_success"');
    });

    it("records upstream_failure signal on UPSTREAM_TIMEOUT", async () => {
      const handler = createHandler(
        testConfig(),
        testDeps({
          execute: () =>
            Promise.reject(new GatewayError("UPSTREAM_TIMEOUT", "timed out")),
        }),
      );
      await handler(envelope());

      const output = capturedOutput();
      expect(output).toContain('"signal":"upstream_failure"');
    });

    it("records upstream_success signal for NOT_FOUND", async () => {
      const handler = createHandler(
        testConfig(),
        testDeps({
          execute: () =>
            Promise.reject(new GatewayError("NOT_FOUND", "not found")),
        }),
      );
      await handler(envelope());

      const output = capturedOutput();
      expect(output).toContain('"signal":"upstream_success"');
    });

    it("records none signal for OPERATION_NOT_FOUND", async () => {
      const handler = createHandler(testConfig(), testDeps());
      await handler(envelope({ operation: "nonexistent" }));

      const output = capturedOutput();
      expect(output).toContain('"signal":"none"');
    });

    it("records unhandled signal for unknown errors", async () => {
      const handler = createHandler(
        testConfig(),
        testDeps({
          execute: () => Promise.reject(new Error("boom")),
        }),
      );
      await handler(envelope());

      const output = capturedOutput();
      expect(output).toContain('"signal":"unhandled"');
    });
  });

  describe("uncaught errors", () => {
    it("wraps non-GatewayError as INTERNAL", async () => {
      const handler = createHandler(
        testConfig(),
        testDeps({
          execute: () => Promise.reject(new Error("something broke")),
        }),
      );
      const resp = await handler(envelope());

      expect(resp.ok).toBe(false);
      const err = resp as EnvelopeError;
      expect(err.error.code).toBe("INTERNAL");
      expect(err.error).toEqual({ code: "INTERNAL" });
    });

    it("does not leak internal error messages to the response", async () => {
      const handler = createHandler(
        testConfig(),
        testDeps({
          execute: () =>
            Promise.reject(new Error("secret database connection string")),
        }),
      );
      const resp = await handler(envelope());

      const err = resp as EnvelopeError;
      expect(JSON.stringify(err)).not.toContain("secret database");
    });

    it("wraps GatewayError thrown by execute", async () => {
      const handler = createHandler(
        testConfig(),
        testDeps({
          execute: () =>
            Promise.reject(new GatewayError("UPSTREAM_TIMEOUT", "timed out")),
        }),
      );
      const resp = await handler(envelope());

      expect(resp.ok).toBe(false);
      const err = resp as EnvelopeError;
      expect(err.error.code).toBe("UPSTREAM_TIMEOUT");
      expect(err.error).toEqual({ code: "UPSTREAM_TIMEOUT" });
      expect(capturedOutput()).toContain("timed out");
    });
  });

  describe("error envelopes carry the code only", () => {
    // A message on the wire would be an unbounded free-text channel out of the trust boundary.
    it.each([
      [
        "a GatewayError from execute",
        () =>
          Promise.reject(
            new GatewayError("UPSTREAM_REJECTED", "nino QQ123456C rejected"),
          ),
      ],
      [
        "an unhandled error",
        () => Promise.reject(new Error("nino QQ123456C blew up")),
      ],
    ])("returns only { code } for %s", async (_label, execute) => {
      const handler = createHandler(testConfig(), testDeps({ execute }));
      const resp = await handler(envelope());

      expect(resp.ok).toBe(false);
      expect(Object.keys((resp as EnvelopeError).error)).toEqual(["code"]);
      expect(JSON.stringify(resp)).not.toContain("QQ123456C");
    });

    it("keeps the detail in the log", async () => {
      const handler = createHandler(
        testConfig(),
        testDeps({
          execute: () =>
            Promise.reject(
              new GatewayError("UPSTREAM_REJECTED", "detail here"),
            ),
        }),
      );
      await handler(envelope());

      expect(capturedOutput()).toContain("detail here");
    });
  });

  describe("config validation at init", () => {
    it("throws on empty operations", () => {
      expect(() =>
        createHandler(
          defineGateway({
            id: "empty",
            driver: { type: "stub" },
            operations: {},
          }),
          testDeps(),
        ),
      ).toThrow("at least one operation");
    });

    it("throws on missing validators for an operation", () => {
      expect(() =>
        createHandler(testConfig(), testDeps({ validators: {} })),
      ).toThrow('Missing validators for operation "ping"');
    });

    it("throws on missing outcome validators", () => {
      expect(() =>
        createHandler(
          testConfig(),
          testDeps({
            validators: {
              ping: { input: alwaysValid, outcomes: {} },
            },
          }),
        ),
      ).toThrow("at least one outcome validator");
    });
  });

  describe("logging: default-deny", () => {
    it("logs only allowlisted input fields", async () => {
      const config = testConfig({
        operations: {
          ping: { log: { input: ["email"] } },
        },
      });
      const handler = createHandler(config, testDeps());

      await handler(
        envelope({
          input: { email: "visible@test.com", secret: "SUPER_SECRET" },
        }),
      );

      const output = capturedOutput();
      expect(output).toContain("visible@test.com");
      expect(output).not.toContain("SUPER_SECRET");
    });

    it("logs only allowlisted output fields", async () => {
      const config = testConfig({
        operations: {
          ping: { log: { output: ["id"] } },
        },
      });
      const handler = createHandler(
        config,
        testDeps({
          execute: () =>
            Promise.resolve({
              outcome: "success",
              data: { id: "pub-id", token: "SECRET_TOKEN" },
            }),
        }),
      );

      await handler(envelope());

      const output = capturedOutput();
      expect(output).toContain("pub-id");
      expect(output).not.toContain("SECRET_TOKEN");
    });

    it("logs no payload fields when log config is absent", async () => {
      const handler = createHandler(testConfig(), testDeps());

      await handler(envelope({ input: { secret: "INPUT_SECRET" } }));

      expect(capturedOutput()).not.toContain("INPUT_SECRET");
    });
  });

  describe("full dispatcher path", () => {
    it("envelope in → driver called via ctx.attempt with signal → validated outcome out", async () => {
      let receivedSignal: AbortSignal | undefined;
      let receivedOperation: string | undefined;
      let receivedInput: unknown;

      const execute: HandlerDeps["execute"] = async (ctx, operation, input) => {
        receivedOperation = operation;
        receivedInput = input;
        return ctx.attempt((signal) => {
          receivedSignal = signal;
          expect(signal).toBeInstanceOf(AbortSignal);
          expect(signal.aborted).toBe(false);
          return Promise.resolve({
            outcome: "success",
            data: { id: "full-path" },
          });
        });
      };

      const handler = createHandler(testConfig(), testDeps({ execute }));
      const resp = await handler(envelope({ input: { key: "value" } }));

      expect(resp.ok).toBe(true);
      const success = resp as EnvelopeSuccess;
      expect(success.outcome).toBe("success");
      expect(success.data).toEqual({ id: "full-path" });

      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(receivedOperation).toBe("ping");
      expect(receivedInput).toEqual({ key: "value" });
    });
  });
});
