import type { DriverDefinition } from "@repo/gateway-config";
import { defineGateway } from "@repo/gateway-config";
import type {
  DriverContext,
  EnvelopeError,
  EnvelopeInbound,
  EnvelopeSuccess,
  Validator,
} from "@repo/gateway-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GatewayError } from "./errors.ts";
import type { AnyGatewayConfig, HandlerDeps } from "./handler.ts";
import { createHandler as createGatewayHandler } from "./handler.ts";

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

// Tests supply execute through the handler's deps; the driver's own factory is never called.
const stubDriver: DriverDefinition = {
  type: "stub",
  createExecutor: () =>
    Promise.reject(new Error("stub driver has no executor")),
};

function testConfig(
  overrides: Partial<{
    operations: Record<
      string,
      {
        description?: string;
        log?: { input?: string[]; output?: string[] };
        secure?: Record<string, string>;
      }
    >;
    policy: { upstreamTimeout: string };
  }> = {},
): AnyGatewayConfig {
  return defineGateway({
    id: "test-gw",
    driver: stubDriver,
    operations: overrides.operations ?? {
      ping: { description: "Test operation" },
    },
    ...(overrides.policy ? { policy: overrides.policy } : {}),
  });
}

const NO_DEADLINE = { remainingMs: () => Infinity };

// Binds one invocation's deadline so the tests below call handlers with the event alone.
function createHandler(
  config: AnyGatewayConfig,
  deps: HandlerDeps,
  deadline = NO_DEADLINE,
) {
  const handle = createGatewayHandler(config, deps);
  return (event: unknown) => handle(event, { deadline });
}

function testDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    validators: {
      ping: { input: alwaysValid, outcomes: { success: alwaysValid } },
    },
    execute: stubExecute,
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

function capturedRecords(): Record<string, unknown>[] {
  return capturedOutput()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
    });

    it("keeps the name it did not recognise out of the message", async () => {
      const handler = createHandler(testConfig(), testDeps());

      await handler(envelope({ operation: "SYNTHETIC-PRIVATE-VALUE" }));

      expect(capturedOutput()).not.toContain("SYNTHETIC-PRIVATE-VALUE");
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
      expect(capturedOutput()).toContain("#/bad");
    });

    it("logs where the schema rejected the input, never a path into it", async () => {
      // A dictionary schema takes an instance path's segments from the caller's own keys, and
      // this message is logged whatever `log.input` selects.
      const dictionaryFailure: Validator = Object.assign(
        (_data: unknown): _data is never => false,
        {
          errors: [
            {
              instancePath: "/national-insurance-number",
              schemaPath: "#/additionalProperties/type",
              message: "must be string",
            },
          ],
        },
      );
      const handler = createHandler(
        testConfig(),
        testDeps({
          validators: {
            ping: {
              input: dictionaryFailure,
              outcomes: { success: alwaysValid },
            },
          },
        }),
      );

      const resp = await handler(
        envelope({ input: { "national-insurance-number": 1 } }),
      );

      expect(resp).toEqual({ ok: false, error: { code: "INVALID_INPUT" } });
      expect(capturedOutput()).toContain("#/additionalProperties/type");
      expect(capturedOutput()).toContain("must be string");
      expect(capturedOutput()).not.toContain("national-insurance-number");
    });

    // A validator that rejects with the given findings, as a generated one leaves on `errors`.
    const rejectingWith = (errors: Validator["errors"]): Validator =>
      Object.assign((_data: unknown): _data is never => false, { errors });

    const reject = async (input: Validator) => {
      const handler = createHandler(
        testConfig(),
        testDeps({
          validators: { ping: { input, outcomes: { success: alwaysValid } } },
        }),
      );
      return handler(envelope({ input: { bad: true } }));
    };

    it("falls back to the schema root and the keyword when a finding gives neither", async () => {
      // A hand-written validator in the shared convention need not fill either field.
      // No schema path and no message: the keyword said nothing either.
      const resp = await reject(
        rejectingWith([{ instancePath: "/bad", schemaPath: "" }]),
      );

      expect(resp).toEqual({ ok: false, error: { code: "INVALID_INPUT" } });
      expect(capturedOutput()).toContain("#: invalid");
      expect(capturedOutput()).not.toContain("/bad");
    });

    it.each([
      ["null findings", null],
      ["no findings at all", undefined],
      ["an empty list of findings", []],
    ])(
      "reports a validator that rejects with %s",
      async (_case, errors: Validator["errors"]) => {
        const resp = await reject(rejectingWith(errors));

        expect(resp).toEqual({ ok: false, error: { code: "INVALID_INPUT" } });
        expect(capturedOutput()).toContain("Input validation failed");
      },
    );

    it("joins every finding a validator reports", async () => {
      await reject(
        rejectingWith([
          {
            instancePath: "/a",
            schemaPath: "#/properties/a/type",
            message: "must be string",
          },
          {
            instancePath: "/b",
            schemaPath: "#/required",
            message: "must have required property 'b'",
          },
        ]),
      );

      expect(capturedOutput()).toContain(
        "#/properties/a/type: must be string; #/required: must have required property 'b'",
      );
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
    const bound = () =>
      testConfig({ operations: { ping: { secure: { userId: "sub" } } } });

    it("accepts envelopes with populated secure block", async () => {
      const handler = createHandler(testConfig(), testDeps());
      const resp = await handler(
        envelope({
          secure: { values: { userId: "abc" }, signature: "sig" },
        }),
      );

      expect(resp.ok).toBe(true);
    });

    it("accepts a bound input matching the secure value", async () => {
      const handler = createHandler(bound(), testDeps());
      const resp = await handler(
        envelope({
          input: { userId: "user-me" },
          secure: { values: { sub: "user-me" }, signature: "sig" },
        }),
      );

      expect(resp.ok).toBe(true);
    });

    it("returns SECURE_VALUE_MISMATCH when input contradicts the envelope", async () => {
      const handler = createHandler(bound(), testDeps());
      const resp = await handler(
        envelope({
          input: { userId: "user-someone-else" },
          secure: { values: { sub: "user-me" }, signature: "sig" },
        }),
      );

      expect(resp.ok).toBe(false);
      expect((resp as EnvelopeError).error.code).toBe("SECURE_VALUE_MISMATCH");
    });

    it("does not call execute on a mismatch", async () => {
      const execute = vi.fn(stubExecute);
      const handler = createHandler(bound(), testDeps({ execute }));

      await handler(
        envelope({
          input: { userId: "user-someone-else" },
          secure: { values: { sub: "user-me" }, signature: "sig" },
        }),
      );

      expect(execute).not.toHaveBeenCalled();
    });

    it("records a trust signal, never an upstream one", async () => {
      // A consumer lying about its identity says nothing about upstream health.
      const handler = createHandler(bound(), testDeps());
      await handler(
        envelope({
          input: { userId: "user-someone-else" },
          secure: { values: { sub: "user-me" }, signature: "sig" },
        }),
      );

      expect(capturedOutput()).toContain('"signal":"trust"');
    });

    it("fails cold start on a malformed binding path", () => {
      expect(() =>
        createHandler(
          testConfig({ operations: { ping: { secure: { "a..b": "sub" } } } }),
          testDeps(),
        ),
      ).toThrow(/Invalid field path/);
    });
  });

  describe("step 6: derive deadline", () => {
    // The budget is what the clock is moved through, so each case says how long the upstream
    // call takes and nothing waits for it.
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const runsFor =
      (ms: number): HandlerDeps["execute"] =>
      async (ctx) => {
        await ctx.upstream(
          () =>
            new Promise((resolve) => {
              setTimeout(resolve, ms);
            }),
        );
        return { outcome: "success", data: {} };
      };

    const TIMED_OUT = { ok: false, error: { code: "UPSTREAM_TIMEOUT" } };
    const SUCCEEDED = { ok: true, outcome: "success" };

    // 600ms of the invocation's time less the 500ms margin leaves a 100ms budget. Were the
    // margin dropped, the 550ms call would sit inside the invocation's own time and succeed.
    it.each([
      ["spends part of the budget", 50, SUCCEEDED],
      ["outlasts it", 550, TIMED_OUT],
    ])(
      "bounds a call that %s by the remaining time less the safety margin",
      async (_label, upstreamMs, expected) => {
        const handler = createHandler(
          testConfig(),
          testDeps({ execute: runsFor(upstreamMs) }),
          { remainingMs: () => 600 },
        );

        const response = handler(envelope());
        await vi.advanceTimersByTimeAsync(upstreamMs);

        await expect(response).resolves.toMatchObject(expected);
      },
    );

    it("takes the deadline from each invocation, not from construction", async () => {
      const attempt = vi.fn(() => Promise.resolve(undefined));
      const handle = createGatewayHandler(
        testConfig(),
        testDeps({
          execute: async (ctx) => {
            await ctx.upstream(attempt);
            return { outcome: "success", data: {} };
          },
        }),
      );

      // Less time left than the margin reserves, so this invocation has no budget at all and
      // never reaches the upstream; the next one, on the same handler, has the whole of it.
      const exhausted = await handle(envelope(), {
        deadline: { remainingMs: () => 100 },
      });
      const roomy = await handle(envelope(), {
        deadline: { remainingMs: () => 10_000 },
      });

      expect((exhausted as EnvelopeError).error.code).toBe("UPSTREAM_TIMEOUT");
      expect(roomy.ok).toBe(true);
      expect(attempt).toHaveBeenCalledOnce();
    });

    // An invocation that leaves the call unbounded: what stops it is the configured policy,
    // and a call inside that timeout still returns.
    it.each([
      ["spends part of the policy timeout", 40, SUCCEEDED],
      ["outlasts it", 5_000, TIMED_OUT],
    ])(
      "bounds a call that %s when the deadline does not constrain it",
      async (_label, upstreamMs, expected) => {
        const handler = createHandler(
          testConfig({ policy: { upstreamTimeout: "50ms" } }),
          testDeps({ execute: runsFor(upstreamMs) }),
        );

        const response = handler(envelope());
        await vi.advanceTimersByTimeAsync(upstreamMs);

        await expect(response).resolves.toMatchObject(expected);
      },
    );
  });

  describe("step 7: run pipeline", () => {
    it("passes a working DriverContext to execute", async () => {
      const execute: HandlerDeps["execute"] = vi.fn(
        async (ctx: DriverContext) => {
          const result = await ctx.upstream((_signal) =>
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
      expect(ctx).toHaveProperty("upstream");
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
            driver: stubDriver,
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

    it("throws on an empty gateway id", () => {
      expect(() =>
        createHandler({ ...testConfig(), id: "" }, testDeps()),
      ).toThrow("non-empty string id");
    });

    it("throws on an operation the configuration names but does not define", () => {
      // Not reachable from a typed configuration; the guard is for a JavaScript caller.
      const config = testConfig();
      const operations = { ...config.operations, pong: undefined };

      expect(() =>
        createHandler(
          { ...config, operations } as unknown as AnyGatewayConfig,
          testDeps({
            validators: {
              ping: { input: alwaysValid, outcomes: { success: alwaysValid } },
              pong: { input: alwaysValid, outcomes: { success: alwaysValid } },
            },
          }),
        ),
      ).toThrow('Operation "pong" missing from config');
    });

    it("throws when an operation's input validator is not a function", () => {
      expect(() =>
        createHandler(
          testConfig(),
          testDeps({
            validators: {
              ping: {
                input: undefined as unknown as Validator,
                outcomes: { success: alwaysValid },
              },
            },
          }),
        ),
      ).toThrow('Missing input validator for operation "ping"');
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

  describe("logging the operation a failed envelope carried", () => {
    it("names it when the envelope carried a configured operation", async () => {
      const handler = createHandler(
        testConfig(),
        testDeps({
          execute: vi
            .fn()
            .mockRejectedValue(
              new GatewayError("UPSTREAM_REJECTED", "upstream said no"),
            ),
        }),
      );

      await handler(envelope({ operation: "ping" }));

      expect(capturedOutput()).toContain('"operation":"ping"');
    });

    it("leaves it out when the envelope named no configured operation", async () => {
      // The name is the caller's own until it matches one of ours, so an unrecognised string
      // reaches no log: it carries whatever the caller chose to send.
      const handler = createHandler(testConfig(), testDeps());

      const resp = await handler(
        envelope({ operation: "SYNTHETIC-PRIVATE-VALUE" }),
      );

      expect(resp).toEqual({
        ok: false,
        error: { code: "OPERATION_NOT_FOUND" },
      });
      for (const record of capturedRecords()) {
        expect(record).not.toHaveProperty("operation");
      }
      expect(capturedOutput()).not.toContain("SYNTHETIC-PRIVATE-VALUE");
    });

    it("leaves it out when the envelope carried no operation at all", async () => {
      const handler = createHandler(testConfig(), testDeps());

      const resp = await handler("not an envelope");

      expect(resp).toEqual({ ok: false, error: { code: "INVALID_INPUT" } });
      for (const record of capturedRecords()) {
        expect(record).not.toHaveProperty("operation");
      }
    });

    it("leaves it out when the envelope carried something else", async () => {
      // Envelope parsing rejects it, and the error path reads the same field to log it.
      const handler = createHandler(testConfig(), testDeps());

      const resp = await handler({
        operation: 42,
        input: {},
        secure: VALID_SECURE,
      });

      expect(resp).toEqual({ ok: false, error: { code: "INVALID_INPUT" } });
      // The field is left out, rather than logged as something else: a substring check would
      // pass on "operation":"42" too.
      for (const record of capturedRecords()) {
        expect(record).not.toHaveProperty("operation");
      }
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
    it("envelope in → driver called via ctx.upstream with signal → validated outcome out", async () => {
      let receivedSignal: AbortSignal | undefined;
      let receivedOperation: string | undefined;
      let receivedInput: unknown;

      const execute: HandlerDeps["execute"] = async (ctx, operation, input) => {
        receivedOperation = operation;
        receivedInput = input;
        return ctx.upstream((signal) => {
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

describe("createHandler, on what a driver logs", () => {
  it("writes a driver's line beside the operation it was called for", async () => {
    const handler = createHandler(
      testConfig(),
      testDeps({
        execute: (ctx) => {
          ctx.log.info("the upstream refused the credentials", {
            status: 401,
          });
          return Promise.resolve({ outcome: "success", data: {} });
        },
      }),
    );

    await handler(envelope());
    const line = capturedRecords().find(
      (record) => record.msg === "the upstream refused the credentials",
    );
    expect(line).toMatchObject({
      level: 30,
      operation: "ping",
      driver: { status: 401 },
    });
  });
});

describe("outcome lookup hardening", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "rejects the undeclared outcome %j even though objects inherit it",
    async (outcome) => {
      const handler = createHandler(
        testConfig(),
        testDeps({
          execute: () => Promise.resolve({ outcome, data: "unvalidated" }),
        }),
      );
      const resp = await handler(envelope());
      expect(resp).toEqual({
        ok: false,
        error: { code: "UPSTREAM_CONTRACT_VIOLATION" },
      });
    },
  );

  it("rejects an outcome validator that is not a function at creation", () => {
    expect(() =>
      createHandler(
        testConfig(),
        testDeps({
          validators: {
            ping: {
              input: alwaysValid,
              outcomes: { success: "nope" as unknown as Validator },
            },
          },
        }),
      ),
    ).toThrow(
      'Outcome "success" of operation "ping" has no validator function',
    );
  });

  it("types validators by the configuration's operations", () => {
    const config = defineGateway({
      id: "typed",
      driver: stubDriver,
      operations: { ping: {}, pong: {} },
    });
    createGatewayHandler(config, {
      validators: {
        ping: { input: alwaysValid, outcomes: { success: alwaysValid } },
        pong: { input: alwaysValid, outcomes: { success: alwaysValid } },
      },
      execute: stubExecute,
    });
    expect(() =>
      createGatewayHandler(config, {
        // @ts-expect-error pong has no validators
        validators: {
          ping: { input: alwaysValid, outcomes: { success: alwaysValid } },
        },
        execute: stubExecute,
      }),
    ).toThrow(/Missing validators for operation "pong"/);
    createGatewayHandler(config, {
      validators: {
        ping: { input: alwaysValid, outcomes: { success: alwaysValid } },
        pong: { input: alwaysValid, outcomes: { success: alwaysValid } },
        // @ts-expect-error pang is not an operation
        pang: { input: alwaysValid, outcomes: { success: alwaysValid } },
      },
      execute: stubExecute,
    });
  });
});

describe("unexpected error logging", () => {
  it("logs the source locations and the dispatcher step, never the message, name, properties or cause", async () => {
    const handler = createHandler(
      testConfig(),
      testDeps({
        execute: () => {
          throw Object.assign(
            new Error(
              "token=SYNTHETIC_MESSAGE\n    at SYNTHETIC_FRAME (/x.ts:1:1)",
            ),
            {
              name: "SYNTHETIC_NAME",
              request: { headers: { authorization: "SYNTHETIC_PROPERTY" } },
              cause: new Error("SYNTHETIC_CAUSE"),
            },
          );
        },
      }),
    );
    const resp = await handler(envelope());
    expect(resp).toEqual({ ok: false, error: { code: "INTERNAL" } });

    const logged = capturedOutput();
    expect(logged).toContain("Unhandled error in dispatcher");
    expect(logged).toContain('"err":{"frames":["at ');
    expect(logged).toContain("handler.test.ts");
    expect(logged).toContain('"step":"execute"');
    expect(logged).not.toMatch(/SYNTHETIC_/);
  });

  it("names the step that was running when validation code itself fails", async () => {
    const throwing: Validator = Object.assign(
      (_data: unknown): _data is never => {
        throw new RangeError("SYNTHETIC");
      },
      { errors: null },
    );
    const handler = createHandler(
      testConfig(),
      testDeps({
        validators: {
          ping: { input: alwaysValid, outcomes: { success: throwing } },
        },
      }),
    );
    await handler(envelope());
    const logged = capturedOutput();
    expect(logged).toContain('"err":{"frames":["at ');
    expect(logged).toContain('"step":"outcome"');
    expect(logged).not.toContain("SYNTHETIC");
  });

  it("returns the INTERNAL envelope even when the error's own properties throw", async () => {
    const hostile = new Error("x");
    Object.defineProperty(hostile, "name", {
      get() {
        throw new Error("SYNTHETIC_GETTER");
      },
    });
    Object.defineProperty(hostile, "stack", { value: 42 });
    const handler = createHandler(
      testConfig(),
      testDeps({
        execute: () => {
          throw hostile;
        },
      }),
    );
    await expect(handler(envelope())).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL" },
    });
    expect(capturedOutput()).not.toContain("SYNTHETIC");
  });

  it("still logs the step and returns INTERNAL when no location is available", async () => {
    const formatted = new Error("SYNTHETIC_MESSAGE");
    void formatted.stack;
    const handler = createHandler(
      testConfig(),
      testDeps({
        execute: () => {
          throw formatted;
        },
      }),
    );
    await expect(handler(envelope())).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL" },
    });
    const logged = capturedOutput();
    expect(logged).toContain('"err":{"frames":[]}');
    expect(logged).toContain('"step":"execute"');
    expect(logged).not.toContain("SYNTHETIC");
  });

  it("keeps a GatewayError's message, which is written to be logged", async () => {
    const handler = createHandler(
      testConfig(),
      testDeps({
        execute: () => {
          throw new GatewayError("INTERNAL", "mapping bug: field x unmapped");
        },
      }),
    );
    await handler(envelope());
    expect(capturedOutput()).toContain("mapping bug: field x unmapped");
  });
});

describe("createHandler, on what a driver reports beside its result", () => {
  const isUuid: Validator = Object.assign(
    (data: unknown): data is string =>
      typeof data === "string" && /^[0-9a-f-]{36}$/.test(data),
    {
      errors: [
        {
          instancePath: "",
          schemaPath: "#/format",
          message: "must match format",
        },
      ],
    },
  );
  const REQUEST_ID = "dbcf549a-43db-4b95-aea8-1e6b792397bb";
  const meta = { upstreamRequestId: isUuid, remaining: alwaysValid };

  const reporting =
    (
      values: Record<string, unknown>,
      then: HandlerDeps["execute"] = stubExecute,
    ): HandlerDeps["execute"] =>
    (ctx, ...rest) => {
      for (const [name, value] of Object.entries(values)) ctx.meta(name, value);
      return then(ctx, ...rest);
    };

  it("returns and logs what the gateway declared, beside a success", async () => {
    const handler = createHandler(
      testConfig(),
      testDeps({
        meta,
        execute: reporting({ upstreamRequestId: REQUEST_ID, remaining: 41 }),
      }),
    );

    await expect(handler(envelope())).resolves.toEqual({
      ok: true,
      outcome: "success",
      data: { id: "123" },
      meta: { upstreamRequestId: REQUEST_ID, remaining: 41 },
    });
    expect(capturedRecords().at(-1)).toMatchObject({
      msg: "response",
      meta: { upstreamRequestId: REQUEST_ID, remaining: 41 },
    });
  });

  it("returns and logs it beside a failure, which is when a caller most needs it", async () => {
    const handler = createHandler(
      testConfig(),
      testDeps({
        meta,
        execute: reporting({ upstreamRequestId: REQUEST_ID }, () => {
          throw new GatewayError("UPSTREAM_ERROR", "Upstream returned 500");
        }),
      }),
    );

    await expect(handler(envelope())).resolves.toEqual({
      ok: false,
      error: { code: "UPSTREAM_ERROR" },
      meta: { upstreamRequestId: REQUEST_ID },
    });
    expect(capturedRecords().at(-1)).toMatchObject({
      code: "UPSTREAM_ERROR",
      meta: { upstreamRequestId: REQUEST_ID },
    });
  });

  it("returns it beside a failure nothing declared, and beside a response its outcome failed", async () => {
    const unexpected = createHandler(
      testConfig(),
      testDeps({
        meta,
        execute: reporting({ upstreamRequestId: REQUEST_ID }, () => {
          throw new TypeError("SYNTHETIC");
        }),
      }),
    );
    await expect(unexpected(envelope())).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL" },
      meta: { upstreamRequestId: REQUEST_ID },
    });

    const violating = createHandler(
      testConfig(),
      testDeps({
        meta,
        validators: {
          ping: { input: alwaysValid, outcomes: { success: alwaysInvalid } },
        },
        execute: reporting({ upstreamRequestId: REQUEST_ID }),
      }),
    );
    await expect(violating(envelope())).resolves.toEqual({
      ok: false,
      error: { code: "UPSTREAM_CONTRACT_VIOLATION" },
      meta: { upstreamRequestId: REQUEST_ID },
    });
  });

  it("has no meta at all when nothing was reported, or the request never reached a driver", async () => {
    const handler = createHandler(testConfig(), testDeps({ meta }));

    expect(await handler(envelope())).not.toHaveProperty("meta");
    expect(await handler(envelope({ operation: "unknown" }))).toEqual({
      ok: false,
      error: { code: "OPERATION_NOT_FOUND" },
    });
  });

  it("carries nothing of one invocation into the next, on the one handler", async () => {
    let reports: string | undefined = REQUEST_ID;
    const handler = createHandler(
      testConfig(),
      testDeps({
        meta,
        execute: (ctx, ...rest) => {
          if (reports !== undefined) ctx.meta("upstreamRequestId", reports);
          return stubExecute(ctx, ...rest);
        },
      }),
    );

    await expect(handler(envelope())).resolves.toMatchObject({
      meta: { upstreamRequestId: REQUEST_ID },
    });
    reports = undefined;

    // The handler is compiled once and serves both, so anything holding what the first reported
    // would answer the second with it.
    expect(await handler(envelope())).not.toHaveProperty("meta");
    expect(capturedRecords().at(-1)).not.toHaveProperty("meta");
  });

  it("keeps two invocations apart while both are in flight", async () => {
    const OTHER_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = createHandler(
      testConfig(),
      testDeps({
        meta,
        execute: async (ctx, _operation, input) => {
          const { requestId } = input as { requestId: string };
          ctx.meta("upstreamRequestId", requestId);
          // The first reports and then waits here while the second runs to the end: what either
          // of them reported into something they share would leave with the other.
          if (requestId === REQUEST_ID) await held;
          return { outcome: "success", data: { id: "123" } };
        },
      }),
    );

    const first = handler(envelope({ input: { requestId: REQUEST_ID } }));
    const second = await handler(envelope({ input: { requestId: OTHER_ID } }));
    release();
    const completed = await first;

    const responded = (id: string) => ({
      ok: true,
      outcome: "success",
      data: { id: "123" },
      meta: { upstreamRequestId: id },
    });
    expect(second).toEqual(responded(OTHER_ID));
    expect(completed).toEqual(responded(REQUEST_ID));
    expect(
      capturedRecords().map((record) => (record as { meta?: unknown }).meta),
    ).toEqual([
      { upstreamRequestId: OTHER_ID },
      { upstreamRequestId: REQUEST_ID },
    ]);
  });

  it("leaves out what the gateway did not declare, without a word of it", async () => {
    const handler = createHandler(
      testConfig(),
      testDeps({
        meta,
        execute: reporting({ sessionToken: "SYNTHETIC-SECRET", remaining: 7 }),
      }),
    );

    await expect(handler(envelope())).resolves.toMatchObject({
      meta: { remaining: 7 },
    });
    expect(capturedOutput()).not.toContain("SYNTHETIC-SECRET");
    expect(capturedOutput()).not.toContain("sessionToken");
  });

  it.each([
    [
      "one its schema refuses",
      "SYNTHETIC-not-a-uuid",
      "#/format: must match format",
    ],
    [
      "an object",
      { id: REQUEST_ID },
      "not a string, a finite number or a boolean",
    ],
    [
      "a number JSON cannot write",
      Number.NaN,
      "not a string, a finite number or a boolean",
    ],
    ["null", null, "not a string, a finite number or a boolean"],
  ])(
    "leaves out %s, says where and never what, and still answers",
    async (_what, value, where) => {
      const handler = createHandler(
        testConfig(),
        testDeps({ meta, execute: reporting({ upstreamRequestId: value }) }),
      );

      await expect(handler(envelope())).resolves.toEqual({
        ok: true,
        outcome: "success",
        data: { id: "123" },
      });
      const warned = capturedRecords().find(
        (record) => record.metadata === "upstreamRequestId",
      );
      expect(warned?.msg).toBe(`Reported metadata left out: ${where}`);
      expect(capturedOutput()).not.toContain("SYNTHETIC");
    },
  );

  it("answers all the same when a validator throws", async () => {
    const throwing: Validator = Object.assign(
      (_data: unknown): _data is unknown => {
        throw new Error("SYNTHETIC validator bug");
      },
      { errors: null },
    );
    const handler = createHandler(
      testConfig(),
      testDeps({
        meta: { upstreamRequestId: throwing },
        execute: reporting({ upstreamRequestId: REQUEST_ID }),
      }),
    );

    await expect(handler(envelope())).resolves.toEqual({
      ok: true,
      outcome: "success",
      data: { id: "123" },
    });
    expect(capturedOutput()).not.toContain("SYNTHETIC");
  });

  it("refuses a metadata validator that is not a function when the handler is created", () => {
    expect(() =>
      createHandler(
        testConfig(),
        testDeps({
          meta: { upstreamRequestId: undefined as unknown as Validator },
        }),
      ),
    ).toThrow(/Metadata "upstreamRequestId" has no validator function/);
  });

  it("returns what was reported before the upstream timed out", async () => {
    // 550ms of the invocation's time less the 500ms margin leaves a 50ms budget, which an
    // upstream that never answers outlasts.
    const handler = createHandler(
      testConfig(),
      testDeps({
        meta,
        execute: reporting({ upstreamRequestId: REQUEST_ID }, (ctx) =>
          ctx.upstream(() => new Promise<never>(() => undefined)),
        ),
      }),
      { remainingMs: () => 550 },
    );

    await expect(handler(envelope())).resolves.toEqual({
      ok: false,
      error: { code: "UPSTREAM_TIMEOUT" },
      meta: { upstreamRequestId: REQUEST_ID },
    });
  });

  it("finds a name an object inherits only if the gateway declared it", async () => {
    const undeclared = createHandler(
      testConfig(),
      testDeps({ meta, execute: reporting({ constructor: "SYNTHETIC" }) }),
    );
    expect(await undeclared(envelope())).not.toHaveProperty("meta");

    const declared = createHandler(
      testConfig(),
      testDeps({
        meta: { constructor: alwaysValid },
        execute: reporting({ constructor: "declared" }),
      }),
    );
    expect(await declared(envelope())).toMatchObject({
      meta: { constructor: "declared" },
    });
  });
});
