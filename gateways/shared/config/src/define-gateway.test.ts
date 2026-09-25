import type {
  ExecuteFn,
  GatewaySchemas,
  OperationHandler,
  SecretProvider,
} from "@repo/gateway-types";
import { describe, expect, expectTypeOf, it } from "vitest";

import { defineGateway } from "./define-gateway.ts";
import type {
  AnyOperations,
  BrandedHandler,
  DriverDefinition,
  ExecutorOptions,
  HandlerOf,
} from "./driver.ts";
import { standardPolicy } from "./presets.ts";
import type { GatewayConfig } from "./types.ts";

// Test definitions are never run; an entrypoint would, and none exists here.
const neverExecutes = () =>
  Promise.reject(new Error("test driver has no executor"));

function stubDriver(): DriverDefinition<{ upstream: string }> {
  return { type: "stub", createExecutor: neverExecutes };
}

// A test-only refinement: an upstream with a "{param}" must declare `parameters`. It shows the
// slot working without this package knowing what a path parameter is.
interface RefinedDriver extends DriverDefinition<{
  upstream: string;
  parameters?: object;
}> {
  readonly type: "refined-stub";
}

declare module "./driver.ts" {
  interface OperationRefinements<TOp> {
    readonly "refined-stub": TOp extends {
      readonly upstream: `${string}{${string}}${string}`;
    }
      ? TOp & { readonly parameters: object }
      : TOp;
  }
}

function refinedDriver(): RefinedDriver {
  return { type: "refined-stub", createExecutor: neverExecutes };
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
    expect(config.operations.op.log?.input).toEqual(["field.path"]);
    expect(config.operations.op.log?.output).toEqual(["result.*.id"]);
  });

  it("supports a handler function on an operation", () => {
    const custom = () => Promise.resolve({ outcome: "ok", data: null });
    const config = defineGateway({
      id: "test",
      driver: stubDriver(),
      operations: {
        custom: { upstream: "POST /custom", handler: custom },
      },
    });

    expect(config.operations.custom.handler).toBe(custom);
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
          handler: () => Promise.resolve({ outcome: "ok", data: null }),
          description: "A fully specified operation",
        },
      },
    });

    expectTypeOf(gw.operations.full.upstream).toBeString();
    expectTypeOf(gw.operations.full.handler).toBeFunction();
  });

  it("passes operations through for a driver with no refinement", () => {
    const gw = defineGateway({
      id: "test",
      driver: stubDriver(),
      operations: { op: { upstream: "GET /x/{id}" } },
    });
    expectTypeOf(gw.operations.op.upstream).toEqualTypeOf<"GET /x/{id}">();
  });

  it("applies a driver's refinement to each operation", () => {
    const gw = defineGateway({
      id: "test",
      driver: refinedDriver(),
      operations: {
        plain: { upstream: "GET /x" },
        declared: { upstream: "GET /x/{id}", parameters: { id: true } },
        // @ts-expect-error the refinement requires parameters when the template has one
        missing: { upstream: "GET /x/{id}" },
      },
    });
    expect(gw.operations.declared.parameters).toEqual({ id: true });
    expectTypeOf<keyof typeof gw.operations>().toEqualTypeOf<
      "plain" | "declared" | "missing"
    >();
  });

  it("rejects a misspelled operation field", () => {
    const gw = defineGateway({
      id: "test",
      driver: stubDriver(),
      operations: {
        op: {
          upstream: "GET /op",
          // @ts-expect-error `hanlder` is not an operation field
          hanlder: () => Promise.resolve({ outcome: "ok", data: null }),
        },
        other: {
          upstream: "GET /other",
          // @ts-expect-error `descripton` is not an operation field
          descripton: "typo",
        },
      },
    });
    expectTypeOf<keyof typeof gw.operations>().toEqualTypeOf<"op" | "other">();
    // Nothing strips the misspelled field; the type error is the only protection.
    expect(gw.operations.other).toEqual({
      upstream: "GET /other",
      descripton: "typo",
    });
  });

  it("rejects a misspelled gateway field", () => {
    const gw = defineGateway({
      id: "test",
      // @ts-expect-error `descripton` is not a gateway field
      descripton: "typo",
      driver: stubDriver(),
      operations: { op: { upstream: "GET /op" } },
    });
    expect(gw).toMatchObject({ id: "test", descripton: "typo" });
  });

  it("works with a driver that requires no extra fields", () => {
    function minimalDriver(): DriverDefinition<Record<string, unknown>> {
      return { type: "minimal", createExecutor: neverExecutes };
    }

    const gw = defineGateway({
      id: "test",
      driver: minimalDriver(),
      operations: {
        op: { handler: () => Promise.resolve({ outcome: "ok", data: null }) },
      },
    });

    expectTypeOf(gw.operations).toHaveProperty("op");
    expectTypeOf<keyof typeof gw.operations>().toEqualTypeOf<"op">();
  });
});

describe("driver contract types", () => {
  // A driver narrows the handler's extra parameters through the definition's phantom type.
  type StubHandler = (
    input: unknown,
    helper: { readonly ping: () => void },
  ) => Promise<{ outcome: string; data: unknown }>;
  interface StubDriver extends DriverDefinition<
    { upstream: string },
    StubHandler
  > {
    readonly type: "typed-stub";
  }
  // A factory rather than a cast: the literal alone would not carry the phantom handler type.
  function typedStubDriver(): StubDriver {
    return { type: "typed-stub", createExecutor: neverExecutes };
  }

  it("types an operation's handler against the driver", () => {
    expectTypeOf<HandlerOf<StubDriver>>().toEqualTypeOf<StubHandler>();
    expectTypeOf<
      HandlerOf<ReturnType<typeof stubDriver>>
    >().toEqualTypeOf<OperationHandler>();

    const stubHandler: StubHandler = (_input, helper) => {
      helper.ping();
      return Promise.resolve({ outcome: "ok", data: null });
    };
    const gw = defineGateway({
      id: "test",
      driver: typedStubDriver(),
      operations: { op: { upstream: "GET /op", handler: stubHandler } },
    });
    expectTypeOf(gw.operations.op.handler).toEqualTypeOf<StubHandler>();

    defineGateway({
      id: "test",
      driver: typedStubDriver(),
      operations: {
        wrong: {
          upstream: "GET /wrong",
          // @ts-expect-error the handler must accept the driver's helper, not a string
          handler: (_i: unknown, s: string) =>
            Promise.resolve({ outcome: s, data: null }),
        },
      },
    });
  });

  it("keeps the executor options to the target, when set, and the secret provider", () => {
    expectTypeOf<ExecutorOptions["target"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<ExecutorOptions>()
      .toHaveProperty("secret")
      .toEqualTypeOf<SecretProvider>();
    expectTypeOf<keyof ExecutorOptions>().toEqualTypeOf<"target" | "secret">();
  });

  it("reserves a build-time check of a configuration against its schemas", () => {
    // Codegen calls it; what the messages mean is the driver's own business, and this package
    // learns no transport vocabulary from holding the slot.
    const driver: DriverDefinition = {
      type: "stub",
      createExecutor: neverExecutes,
      checkSchemas: (config, schemas) =>
        Object.keys(schemas.operations)
          .filter((name) => !Object.hasOwn(config.operations, name))
          .map((name) => `no operation "${name}"`),
    };
    const gw = defineGateway({
      id: "test",
      driver,
      operations: { op: { upstream: "GET /op" } },
    });
    const schemas: GatewaySchemas = {
      operations: { other: { input: {}, outcomes: {} } },
    };

    expect(gw.driver.checkSchemas?.(gw, schemas)).toEqual([
      'no operation "other"',
    ]);
  });

  it("brands a handler with the driver it was written for", () => {
    type Fn = (input: unknown) => Promise<{ outcome: string; data: unknown }>;
    type ForStub = BrandedHandler<"typed-stub", Fn>;
    type ForOther = BrandedHandler<"other", Fn>;

    // The brand narrows: a branded handler is still an OperationHandler, but a plain function
    // or another driver's handler is not assignable to the branded type.
    expectTypeOf<ForStub>().toExtend<OperationHandler>();
    expectTypeOf<ForStub>().toExtend<Fn>();
    expectTypeOf<Fn>().not.toExtend<ForStub>();
    expectTypeOf<ForOther>().not.toExtend<ForStub>();
  });

  it("carries an asynchronous createExecutor that receives the configuration", async () => {
    // The contract receives the configuration as the runtime holds it.
    expectTypeOf<
      Parameters<DriverDefinition["createExecutor"]>[0]
    >().toEqualTypeOf<
      GatewayConfig<DriverDefinition, AnyOperations<DriverDefinition>>
    >();

    // A driver's factory takes its own configuration type; a method parameter permits it.
    const execute: ExecuteFn = () =>
      Promise.resolve({ outcome: "ok", data: null });
    const createExecutor = (
      config: GatewayConfig<StubDriver, AnyOperations<StubDriver>>,
      options: ExecutorOptions,
    ): Promise<ExecuteFn> => {
      expectTypeOf(config.driver).toEqualTypeOf<StubDriver>();
      expectTypeOf(options).toEqualTypeOf<ExecutorOptions>();
      return Promise.resolve(execute);
    };
    const driver: StubDriver = { type: "typed-stub", createExecutor };

    // What an entrypoint does: the driver is reached through the configuration it is part of,
    // so nothing outside the configuration names a driver package.
    const gw = defineGateway({
      id: "test",
      driver,
      operations: { op: { upstream: "GET /op" } },
    });
    const created = await gw.driver.createExecutor(gw, {
      target: "https://upstream.example",
      secret: { get: () => Promise.resolve({}) },
    });
    expect(created).toBe(execute);

    // A synchronous factory does not satisfy the contract: creation retrieves the secret.
    const synchronous = {
      type: "typed-stub" as const,
      createExecutor: () => execute,
    };
    expectTypeOf(synchronous).not.toExtend<StubDriver>();
  });
});
