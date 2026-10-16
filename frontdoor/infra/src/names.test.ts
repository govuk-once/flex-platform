import { describe, expect, it } from "vitest";

import {
  accessLogsName,
  edgeRoleName,
  originRequestFunctionName,
  originRequestLogGroupName,
  originRequestLogsPolicyName,
  viewerRequestFunctionName,
  viewerRequestLogGroupName,
  wafLogGroupName,
  webAclName,
} from "./names.ts";

describe("names", () => {
  it("derive from the environment's name alone", () => {
    expect(webAclName("sandbox")).toBe("frontdoor-sandbox-web-acl");
    expect(wafLogGroupName("sandbox")).toBe(
      "aws-waf-logs-frontdoor-sandbox-web-acl",
    );
    expect(accessLogsName("sandbox")).toBe("frontdoor-sandbox-access-logs");
    expect(viewerRequestFunctionName("sandbox")).toBe(
      "frontdoor-sandbox-viewer-request",
    );
    expect(viewerRequestLogGroupName("sandbox")).toBe(
      "/aws/cloudfront/function/frontdoor-sandbox-viewer-request",
    );
    expect(originRequestFunctionName("sandbox")).toBe(
      "frontdoor-sandbox-origin-request",
    );
    expect(edgeRoleName("sandbox")).toBe("frontdoor-sandbox-edge");
    expect(originRequestLogGroupName("sandbox")).toBe(
      "/flex/frontdoor/sandbox/origin-request",
    );
    expect(originRequestLogsPolicyName("sandbox", "eu-west-2")).toBe(
      "frontdoor-sandbox-origin-request-logs-eu-west-2",
    );
  });
});
