import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, TEST_USERS } from "../../../test/helpers.ts";
import { trustedIssuers } from "./trusted-issuers.ts";

const [, , PROD] = FIXTURE_STAGES;
const [TRUSTING, NOT_TRUSTING] = PROD.environments;

describe("trustedIssuers", () => {
  it("is the environment's issuers when it names no test user issuer", () => {
    expect(trustedIssuers(NOT_TRUSTING)).toEqual(
      NOT_TRUSTING.frontdoor.issuers,
    );
  });

  it("adds its test user issuer after them when it names one", () => {
    expect(trustedIssuers(TRUSTING)).toEqual([
      ...TRUSTING.frontdoor.issuers,
      TEST_USERS,
    ]);
  });
});
