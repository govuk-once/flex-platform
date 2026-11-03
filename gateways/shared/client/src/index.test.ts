import { afterEach, describe, expect, it, vi } from "vitest";

import { createGatewayClient } from "./index.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

// The name it builds is checked by codegen's test of a gateway's package, which calls a stand-in
// for Lambda's API under plain Node.
describe("createGatewayClient", () => {
  it("refuses to start without FLEX_ENVIRONMENT", () => {
    vi.stubEnv("FLEX_ENVIRONMENT", undefined);
    expect(() => createGatewayClient("fixture", ["getUser"])).toThrow(
      'FLEX_ENVIRONMENT is not set, so the gateway "fixture" cannot be named.',
    );
  });

  it("refuses an environment that cannot name a function", () => {
    vi.stubEnv("FLEX_ENVIRONMENT", "Production");
    expect(() => createGatewayClient("fixture", ["getUser"])).toThrow(
      /The environment "Production" must be/,
    );
  });

  it("creates a client for the environment it names", () => {
    vi.stubEnv("FLEX_ENVIRONMENT", "production");
    const client = createGatewayClient("fixture", ["getUser"]);
    expect(Object.keys(client)).toEqual(["getUser"]);
  });
});
