import { describe, expect, it } from "vitest";

import {
  accessLogsName,
  originDomainName,
  wafLogGroupName,
  webAclName,
} from "./names.ts";

describe("names", () => {
  it("derive from the environment's name and domain name alone", () => {
    expect(originDomainName("sandbox.flex.example")).toBe(
      "api.sandbox.flex.example",
    );
    expect(webAclName("sandbox")).toBe("frontdoor-sandbox");
    expect(wafLogGroupName("sandbox")).toBe("aws-waf-logs-frontdoor-sandbox");
    expect(accessLogsName("sandbox")).toBe("frontdoor-sandbox-access-logs");
  });
});
