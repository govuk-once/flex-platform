import { afterEach, describe, expect, it, vi } from "vitest";

import { createGatewayClient } from "./index.ts";

interface Operations {
  readonly getUser: {
    readonly input: { readonly id: string };
    readonly response: unknown;
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// The name it builds is checked by codegen's test of a gateway's package, which calls a stand-in
// for Lambda's API under plain Node.
describe("createGatewayClient", () => {
  it("creates a client without FLEX_ENVIRONMENT, as a module does when it is imported", () => {
    vi.stubEnv("FLEX_ENVIRONMENT", undefined);
    const client = createGatewayClient<Operations>("fixture", ["getUser"]);
    expect(Object.keys(client)).toEqual(["getUser"]);
  });

  it("refuses a call without FLEX_ENVIRONMENT", async () => {
    vi.stubEnv("FLEX_ENVIRONMENT", undefined);
    const client = createGatewayClient<Operations>("fixture", ["getUser"]);
    await expect(client.getUser({ id: "u1" })).rejects.toThrow(
      'FLEX_ENVIRONMENT is not set, so the gateway "fixture" cannot be named.',
    );
  });

  it("refuses a call in an environment that cannot name a function", async () => {
    vi.stubEnv("FLEX_ENVIRONMENT", "Production");
    const client = createGatewayClient<Operations>("fixture", ["getUser"]);
    await expect(client.getUser({ id: "u1" })).rejects.toThrow(
      /The environment "Production" must be/,
    );
  });

  it("reads the environment set after the client was created", async () => {
    vi.stubEnv("FLEX_ENVIRONMENT", undefined);
    const client = createGatewayClient<Operations>("fixture", ["getUser"]);
    vi.stubEnv("FLEX_ENVIRONMENT", "production");
    // Named, so the call gets as far as its caller's context, which this test gives none.
    await expect(client.getUser({ id: "u1" })).rejects.toThrow(
      /must be made inside withCallerContext/,
    );
  });
});
