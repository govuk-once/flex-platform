import { gatewayFunctionName } from "@repo/gateway-core";
import { describe, expect, it } from "vitest";

import {
  gatewayFunctionPattern,
  gatewayLogGroupName,
  gatewayRoleName,
  gatewayRolePattern,
  gatewaySecretName,
  gatewaySecretPattern,
} from "./names.ts";

describe("gateway names", () => {
  it("matches every gateway's function in the environment", () => {
    expect(gatewayFunctionPattern("production")).toBe("gateway-production-*");
    expect(gatewayFunctionName("production", "udp")).toMatch(
      /^gateway-production-/,
    );
  });

  it("matches every gateway's role and created secret in the environment, and nothing else of theirs", () => {
    const role = gatewayRolePattern("production");
    const secret = gatewaySecretPattern("production");
    expect(role).toBe("gateway-production-*-execution");
    expect(secret).toBe("gateway-production-*");

    const glob = (pattern: string) =>
      new RegExp(`^${pattern.replaceAll("*", ".*")}$`);
    expect(gatewayRoleName("production", "udp")).toMatch(glob(role));
    expect(gatewaySecretName("production", "udp")).toMatch(glob(secret));
    expect("gateway-staging-udp-execution").not.toMatch(glob(role));
    expect("domain-production-udp-execution").not.toMatch(glob(role));
  });

  it("refuses an environment that cannot name a function", () => {
    expect(() => gatewayFunctionPattern("Production")).toThrow(
      /The environment .* must be/,
    );
    expect(() => gatewayRolePattern("Production")).toThrow(
      /The environment .* must be/,
    );
  });

  it("derives each of a gateway's names from its environment and id", () => {
    expect(gatewayRoleName("production", "udp")).toBe(
      "gateway-production-udp-execution",
    );
    expect(gatewayLogGroupName("production", "udp")).toBe(
      "/flex/gateway/production/udp/function",
    );
    expect(gatewaySecretName("production", "udp")).toBe(
      "gateway-production-udp",
    );
  });

  it("refuses an id that cannot name a function", () => {
    expect(() => gatewayLogGroupName("production", "UDP")).toThrow(
      /The gateway id .* must be/,
    );
  });

  it("refuses a role name longer than IAM allows", () => {
    // 61 characters as a function, 71 as a role.
    const environment = "e".repeat(20);
    const id = "a".repeat(32);
    expect(() => gatewayFunctionName(environment, id)).not.toThrow();
    expect(() => gatewayRoleName(environment, id)).toThrow(
      /longer than IAM's 64/,
    );
  });
});
