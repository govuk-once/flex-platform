import { describe, expect, it } from "vitest";

import {
  accessLogsName,
  callerTokenKeysBucketName,
  edgeRoleName,
  keyRotationAlarmName,
  keyRotationFunctionName,
  keyRotationLogGroupName,
  keyRotationRoleName,
  keyRotationScheduleRoleName,
  keyRotationStateParameterName,
  originRequestFunctionName,
  originRequestLogGroupName,
  originRequestLogsPolicyName,
  originRequestPolicyName,
  responseHeadersPolicyName,
  signingKeyAliasName,
  signingKeyParameterName,
  viewerRequestFunctionName,
  webAclName,
} from "./names.ts";

describe("names", () => {
  it("derive from the environment's name alone", () => {
    expect(webAclName("sandbox")).toBe("frontdoor-sandbox-web-acl");
    expect(accessLogsName("sandbox")).toBe("frontdoor-sandbox-access-logs");
    expect(viewerRequestFunctionName("sandbox")).toBe(
      "frontdoor-sandbox-viewer-request",
    );
    expect(originRequestFunctionName("sandbox")).toBe(
      "frontdoor-sandbox-origin-request",
    );
    expect(originRequestPolicyName("sandbox")).toBe(
      "frontdoor-sandbox-forwarded-headers",
    );
    expect(responseHeadersPolicyName("sandbox")).toBe(
      "frontdoor-sandbox-response-headers",
    );
    expect(edgeRoleName("sandbox")).toBe("frontdoor-sandbox-edge");
    expect(callerTokenKeysBucketName("sandbox", "100000000002")).toBe(
      "frontdoor-sandbox-keys-100000000002",
    );
    expect(keyRotationRoleName("sandbox")).toBe(
      "frontdoor-sandbox-key-rotation",
    );
    expect(keyRotationFunctionName("sandbox")).toBe(
      "frontdoor-sandbox-key-rotation",
    );
    expect(keyRotationScheduleRoleName("sandbox")).toBe(
      "frontdoor-sandbox-key-rotation-schedule",
    );
    expect(keyRotationAlarmName("sandbox")).toBe(
      "frontdoor-sandbox-key-rotation-failed",
    );
    expect(keyRotationLogGroupName("sandbox")).toBe(
      "/flex/frontdoor/sandbox/key-rotation",
    );
    expect(keyRotationStateParameterName("sandbox")).toBe(
      "/flex/frontdoor/sandbox/caller-token-key-state",
    );
    expect(signingKeyAliasName("sandbox")).toBe(
      "alias/frontdoor-sandbox-caller-token",
    );
    expect(signingKeyParameterName("sandbox")).toBe(
      "/flex/frontdoor/sandbox/caller-token-signing-key",
    );
    expect(originRequestLogGroupName("sandbox")).toBe(
      "/flex/frontdoor/sandbox/origin-request",
    );
    expect(originRequestLogsPolicyName("sandbox", "eu-west-2")).toBe(
      "frontdoor-sandbox-origin-request-logs-eu-west-2",
    );
  });

  it("keeps the public keys' bucket within S3's 63 characters for the longest environment name", () => {
    expect(
      callerTokenKeysBucketName("e".repeat(32), "100000000002").length,
    ).toBeLessThanOrEqual(63);
  });
});
