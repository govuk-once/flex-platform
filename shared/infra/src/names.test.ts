import { describe, expect, it } from "vitest";

import {
  CI_ORIGIN_HOST_PARAMETER,
  ciAudience,
  PIPELINE_TOKEN_ISSUER,
} from "./names.ts";

describe("names", () => {
  // A job asks GitHub for a token with this audience, so it is the address the job calls.
  it("makes the pipeline API's own address the audience of its tokens", () => {
    expect(ciAudience("sandbox.flex-shared.example")).toBe(
      "https://sandbox.flex-shared.example/ci",
    );
  });

  it("trusts GitHub Actions' issuer, as its tokens write it", () => {
    expect(PIPELINE_TOKEN_ISSUER).toBe(
      "https://token.actions.githubusercontent.com",
    );
  });

  it("keeps the host's parameter under the path for values written across regions", () => {
    expect(CI_ORIGIN_HOST_PARAMETER).toBe(
      "/flex/cross-region/shared/ci-origin-host",
    );
  });
});
