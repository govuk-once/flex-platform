import type { DriverDefinition } from "@repo/gateway-config";
import type { GatewaySchemas } from "@repo/gateway-types";
import { describe, expect, it } from "vitest";

import { checkGateway, GatewayCheckError } from "./check-gateway.ts";
import type { AnyGatewayConfig } from "./load-config.ts";

const noExecutor = () =>
  Promise.reject(new Error("test driver has no executor"));

function gateway(
  operations: Record<string, Record<string, unknown>>,
  driver: Partial<DriverDefinition> = {},
): AnyGatewayConfig {
  return {
    id: "test",
    driver: { type: "stub", createExecutor: noExecutor, ...driver },
    operations,
  };
}

const schemas = (operations: Record<string, unknown>): GatewaySchemas =>
  ({ operations }) as GatewaySchemas;

const opSchemas = {
  input: { type: "object" },
  outcomes: { ok: { type: "object" } },
};

function problemsOf(call: () => void): readonly string[] {
  try {
    call();
  } catch (error: unknown) {
    if (error instanceof GatewayCheckError) return error.problems;
    throw error;
  }
  return [];
}

describe("checkGateway", () => {
  it("accepts a configuration whose schemas match", () => {
    expect(() =>
      checkGateway(gateway({ ping: {} }), schemas({ ping: opSchemas })),
    ).not.toThrow();
  });

  it("names every problem in one message", () => {
    const error = problemsOf(() =>
      checkGateway(gateway({ ping: {} }), schemas({ pong: opSchemas })),
    );

    expect(error).toEqual([
      'operation "ping" has no schemas',
      'schemas declare operation "pong", which the configuration does not',
    ]);
  });

  it("reports a gateway with no operations", () => {
    expect(problemsOf(() => checkGateway(gateway({}), schemas({})))).toEqual([
      "the configuration declares no operations",
    ]);
  });

  it("reports an operation with no input schema or no outcomes", () => {
    const problems = problemsOf(() =>
      checkGateway(gateway({ ping: {} }), schemas({ ping: { outcomes: {} } })),
    );

    expect(problems).toEqual([
      'operation "ping" has no input schema',
      'operation "ping" declares no outcomes',
    ]);
  });

  it("does not mistake an inherited member for a declared operation", () => {
    // A plain lookup of "constructor" finds Object.prototype's, so the missing schemas would
    // pass unnoticed. The check reads own properties only.
    expect(
      problemsOf(() => checkGateway(gateway({ constructor: {} }), schemas({}))),
    ).toEqual(['operation "constructor" has no schemas']);
  });

  it("holds what is reported beside a result to one scalar type", () => {
    const reporting = (meta: Record<string, unknown>): GatewaySchemas =>
      ({ meta, operations: { ping: opSchemas } }) as GatewaySchemas;

    expect(
      problemsOf(() => {
        checkGateway(
          gateway({ ping: {} }),
          reporting({
            requestId: { type: "string" },
            remaining: { type: "integer" },
            flagged: { type: "boolean" },
          }),
        );
      }),
    ).toEqual([]);
    expect(
      problemsOf(() => {
        checkGateway(
          gateway({ ping: {} }),
          reporting({
            trace: { type: "object" },
            either: { type: ["string", "null"] },
            untyped: {},
          }),
        );
      }),
    ).toEqual([
      'metadata "trace" must declare one type, of string, number, integer, boolean',
      'metadata "either" must declare one type, of string, number, integer, boolean',
      'metadata "untyped" must declare one type, of string, number, integer, boolean',
    ]);
  });

  it("surfaces the driver's own findings", () => {
    const problems = problemsOf(() =>
      checkGateway(
        gateway({ ping: {} }, { checkSchemas: () => ["the driver disagrees"] }),
        schemas({ ping: opSchemas }),
      ),
    );

    expect(problems).toEqual(["the driver disagrees"]);
  });

  it("passes the configuration and schemas to the driver", () => {
    const seen: unknown[] = [];
    const config = gateway(
      { ping: {} },
      {
        checkSchemas: (...args) => {
          seen.push(...args);
          return [];
        },
      },
    );
    const gatewaySchemas = schemas({ ping: opSchemas });

    checkGateway(config, gatewaySchemas);

    expect(seen).toEqual([config, gatewaySchemas]);
  });

  it("refuses a driver that answers with something other than a list", () => {
    expect(() =>
      checkGateway(
        gateway(
          { ping: {} },
          {
            checkSchemas: () => "nope" as unknown as readonly string[],
          },
        ),
        schemas({ ping: opSchemas }),
      ),
    ).toThrow(/must return an array/);
  });

  it("puts the gateway id and every problem in the message", () => {
    expect(() => checkGateway(gateway({}), schemas({}))).toThrow(
      /Gateway "test" configuration and schemas do not agree:\n {2}- the configuration declares no operations/,
    );
  });
});
