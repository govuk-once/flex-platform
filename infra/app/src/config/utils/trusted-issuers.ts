import type { TrustedIssuer } from "@repo/frontdoor-shared";

import type { EnvironmentConfig } from "../types.ts";

/**
 * The issuers an environment's edge lets through: its own, and its test user pool where it names
 * one.
 */
export function trustedIssuers(
  environment: EnvironmentConfig,
): readonly TrustedIssuer[] {
  const { issuers, testUserIssuer } = environment.frontdoor;
  return testUserIssuer === null ? issuers : [...issuers, testUserIssuer];
}
