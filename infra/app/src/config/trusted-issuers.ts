import type { TrustedIssuer } from "@repo/frontdoor-shared";

import type { EnvironmentConfig, StageConfig } from "./types.ts";

/**
 * The issuers an environment's edge lets through: its own, and the stage's test user pool when the
 * environment trusts test users. A test user's username is whatever its creator chose, and the
 * edge passes it on as the caller's pairwise ID, so only this opts an environment in.
 */
export function trustedIssuers(
  stage: StageConfig,
  environment: EnvironmentConfig,
): readonly TrustedIssuer[] {
  const { issuers, testUsers } = environment.frontdoor;
  if (!testUsers) return issuers;
  const pool = stage.shared.testUsers;
  if (pool === null) {
    throw new Error(
      `${stage.name}/${environment.name}: the frontdoor trusts test users, but ${stage.name} names no test user pool`,
    );
  }
  return [...issuers, pool];
}
