import { describe, expect, it } from "vitest";

import { gatewayFunctionName, gatewayFunctionPattern } from "./names.ts";

describe("gateway names", () => {
  it("names a gateway's function from its environment and id", () => {
    expect(gatewayFunctionName("production", "udp")).toBe(
      "gateway-production-udp",
    );
  });

  it("matches every gateway's function in the environment", () => {
    expect(gatewayFunctionPattern("production")).toBe("gateway-production-*");
  });
});
