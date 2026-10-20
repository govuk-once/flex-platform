import { HEADERS_SET_BY_FUNCTION } from "@repo/frontdoor-origin-request";
import { describe, expect, it } from "vitest";

import { FORWARDED_HEADERS } from "./origin-request-policy.ts";

describe("EdgeOriginRequestPolicy", () => {
  // CloudFront forwards a header a Lambda@Edge function adds only some of the time unless the
  // origin request policy names it: the SigV4 probe saw unnamed ones arrive about half the time.
  // Only `host` and AWS's `x-amz-*` signing headers always arrived. A header missing here would
  // fail only some of the time, in production.
  it("names every header Lambda@Edge sets, so CloudFront always forwards it", () => {
    const needed = HEADERS_SET_BY_FUNCTION.filter(
      (name) => name !== "host" && !name.startsWith("x-amz-"),
    );

    expect(needed.length).toBeGreaterThan(0);
    for (const name of needed) {
      expect(FORWARDED_HEADERS, name).toContain(name);
    }
  });
});
