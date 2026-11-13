import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, TEST_USERS } from "../../test/helpers.ts";
import { trustedIssuers } from "./trusted-issuers.ts";
import type { EnvironmentConfig, StageConfig } from "./types.ts";

const [DEV_STAGE, , PROD] = FIXTURE_STAGES;
const [TRUSTING, NOT_TRUSTING] = PROD.environments;

describe("trustedIssuers", () => {
  it("is the environment's issuers when it doesn't trust test users", () => {
    expect(trustedIssuers(PROD, NOT_TRUSTING)).toEqual(
      NOT_TRUSTING.frontdoor.issuers,
    );
  });

  it("adds the stage's test user pool after them when it does", () => {
    expect(trustedIssuers(PROD, TRUSTING)).toEqual([
      ...TRUSTING.frontdoor.issuers,
      TEST_USERS,
    ]);
  });

  // Validation refuses this first. Building the edge refuses it too, rather than trust less.
  it("refuses trust in test users where the stage has no pool", () => {
    const stage: StageConfig = DEV_STAGE;
    const environment: EnvironmentConfig = {
      ...TRUSTING,
      name: "sandbox",
    };
    expect(() => trustedIssuers(stage, environment)).toThrow(
      "platform-dev/sandbox: the frontdoor trusts test users, but platform-dev names no test user pool",
    );
  });
});
