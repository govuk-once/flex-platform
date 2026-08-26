import { describe, expect, expectTypeOf, it } from "vitest";

import { defineGateway } from "./define-gateway.ts";
import type { DriverDefinition } from "./driver.ts";
import { standardPolicy } from "./presets.ts";

function stubDriver(): DriverDefinition<{ upstream: string }> {
  return { type: "stub" };
}

describe("defineGateway", () => {
  it("applies standardPolicy as default when no policy provided", () => {
    const config = defineGateway({
      id: "test",
      driver: stubDriver(),
      operations: {
        ping: { upstream: "GET /ping" },
      },
    });

    expect(config.id).toBe("test");
    expect(config.operations.ping.upstream).toBe("GET /ping");
    expect(config.policy).toEqual(standardPolicy);
  });

  it("preserves optional fields when provided", () => {
    const config = defineGateway({
      id: "test",
      description: "A test gateway",
      driver: stubDriver(),
      policy: { ...standardPolicy, upstreamTimeout: "3s" },
      operations: {
        op: {
          upstream: "GET /op",
          log: { input: ["field.path"], output: ["result.*.id"] },
          description: "An operation",
        },
      },
    });

    expect(config.description).toBe("A test gateway");
    expect(config.policy?.upstreamTimeout).toBe("3s");
    expect(config.policy?.attempts).toBe(1);
    expect(config.operations.op.log?.input).toEqual(["field.path"]);
    expect(config.operations.op.log?.output).toEqual(["result.*.id"]);
  });

  it("supports handler escape hatch", () => {
    const config = defineGateway({
      id: "test",
      driver: stubDriver(),
      operations: {
        custom: {
          upstream: "POST /custom",
          handler: "./src/operations/custom",
        },
      },
    });

    expect(config.operations.custom.handler).toBe("./src/operations/custom");
  });
});

describe("defineGateway type inference", () => {
  it("preserves operation keys as literal types", () => {
    const gw = defineGateway({
      id: "udp",
      driver: stubDriver(),
      operations: {
        getAddress: { upstream: "GET /addresses/{uprn}" },
        verify: { upstream: "POST /verify" },
      },
    });

    expectTypeOf(gw.operations).toHaveProperty("getAddress");
    expectTypeOf(gw.operations).toHaveProperty("verify");
    expectTypeOf<keyof typeof gw.operations>().toEqualTypeOf<
      "getAddress" | "verify"
    >();
  });

  it("accepts operations with all optional base fields", () => {
    const gw = defineGateway({
      id: "test",
      driver: stubDriver(),
      operations: {
        full: {
          upstream: "GET /full",
          log: { input: ["a.b"], output: ["c.*.d"] },
          handler: "./src/full",
          description: "A fully specified operation",
        },
      },
    });

    expectTypeOf(gw.operations.full.upstream).toBeString();
    expectTypeOf(gw.operations.full.handler).toBeString();
  });

  it("works with a driver that requires no extra fields", () => {
    function minimalDriver(): DriverDefinition<Record<string, unknown>> {
      return { type: "minimal" };
    }

    const gw = defineGateway({
      id: "test",
      driver: minimalDriver(),
      operations: {
        op: { handler: "./src/op" },
      },
    });

    expectTypeOf(gw.operations).toHaveProperty("op");
    expectTypeOf<keyof typeof gw.operations>().toEqualTypeOf<"op">();
  });
});
