import { describe, expect, it } from "vitest";

import {
  assertGatewayId,
  gatewayFunctionName,
  gatewayFunctionPrefix,
} from "./names.ts";

const INVALID_NAMES = [
  "",
  "Udp",
  "1udp",
  "udp-",
  "udp_v2",
  "udp:live",
  "../udp",
  "a".repeat(33),
];

describe("gatewayFunctionName", () => {
  it("names the function from the environment and the gateway's id", () => {
    expect(gatewayFunctionName("production", "udp")).toBe(
      "gateway-production-udp",
    );
    expect(gatewayFunctionName("development", "dvla-vehicles")).toBe(
      "gateway-development-dvla-vehicles",
    );
  });

  it("accepts a name up to Lambda's limit", () => {
    const name = gatewayFunctionName("e".repeat(23), "g".repeat(32));
    expect(name).toHaveLength(64);
  });

  it("refuses a name beyond Lambda's limit", () => {
    expect(() => gatewayFunctionName("e".repeat(24), "g".repeat(32))).toThrow(
      /longer than Lambda's 64 characters/,
    );
  });

  it.each(INVALID_NAMES)("refuses the gateway id %j", (id) => {
    expect(() => gatewayFunctionName("production", id)).toThrow(
      /The gateway id .* must be/,
    );
  });

  it.each(INVALID_NAMES)("refuses the environment %j", (environment) => {
    expect(() => gatewayFunctionName(environment, "udp")).toThrow(
      /The environment .* must be/,
    );
  });
});

describe("gatewayFunctionPrefix", () => {
  it("starts every gateway's function name in the environment", () => {
    expect(gatewayFunctionPrefix("production")).toBe("gateway-production-");
    expect(
      gatewayFunctionName("production", "udp").startsWith(
        gatewayFunctionPrefix("production"),
      ),
    ).toBe(true);
  });

  it.each(INVALID_NAMES)("refuses the environment %j", (environment) => {
    expect(() => gatewayFunctionPrefix(environment)).toThrow(
      /The environment .* must be/,
    );
  });
});

describe("assertGatewayId", () => {
  it("accepts an id of 1 to 32 characters", () => {
    expect(() => assertGatewayId("a")).not.toThrow();
    expect(() => assertGatewayId("a".repeat(32))).not.toThrow();
  });

  it.each(INVALID_NAMES)("refuses %j", (id) => {
    expect(() => assertGatewayId(id)).toThrow(/The gateway id .* must be/);
  });
});
