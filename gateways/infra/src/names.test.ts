import { gatewayFunctionName } from "@repo/gateway-core";
import { describe, expect, it } from "vitest";

import { gatewayFunctionPattern } from "./names.ts";

describe("gateway names", () => {
  it("matches every gateway's function in the environment", () => {
    expect(gatewayFunctionPattern("production")).toBe("gateway-production-*");
    expect(gatewayFunctionName("production", "udp")).toMatch(
      /^gateway-production-/,
    );
  });

  it("refuses an environment that cannot name a function", () => {
    expect(() => gatewayFunctionPattern("Production")).toThrow(
      /The environment .* must be/,
    );
  });
});
