import { describe, expect, it } from "vitest";

import {
  apiAccessLogGroupName,
  apiAlarmName,
  apiExecutionLogGroupName,
  apiMetricNamespace,
  apiName,
  certificateParameterName,
  deployRoleName,
  domainFunctionName,
  domainHost,
  executionRoleName,
  functionLogGroupName,
} from "./names.ts";

describe("names", () => {
  it("name a domain's function and API from the environment's and the domain's names", () => {
    expect(domainFunctionName("sandbox", "domain-a")).toBe(
      "domain-sandbox-domain-a",
    );
    expect(apiName("sandbox", "domain-a")).toBe("domain-sandbox-domain-a-api");
  });

  it("name a domain's API alarms after its API, and give its metrics a namespace of their own", () => {
    expect(apiAlarmName("sandbox", "domain-a", "signing-faults")).toBe(
      "domain-sandbox-domain-a-api-signing-faults",
    );
    expect(apiMetricNamespace("sandbox", "domain-a")).toBe(
      "flex/domain/sandbox/domain-a/api",
    );
  });

  it("put a domain's host under its account's zone", () => {
    expect(domainHost("domain-a", "sandbox.flex-domain00.example")).toBe(
      "domain-a.sandbox.flex-domain00.example",
    );
  });

  it("name a domain's roles after its function", () => {
    expect(executionRoleName("sandbox", "domain-a")).toBe(
      "domain-sandbox-domain-a-execution",
    );
    expect(deployRoleName("sandbox", "domain-a")).toBe(
      "domain-sandbox-domain-a-deploy",
    );
  });

  it("give a domain no 64-character-limited name longer than its execution role's", () => {
    const longest = executionRoleName("e", "d").length;
    for (const name of [
      domainFunctionName("e", "d"),
      deployRoleName("e", "d"),
    ]) {
      expect(name.length).toBeLessThanOrEqual(longest);
    }
  });

  it("put the platform's log groups and parameters under /flex/domain", () => {
    expect(functionLogGroupName("sandbox", "domain-a")).toBe(
      "/flex/domain/sandbox/domain-a/function",
    );
    expect(apiAccessLogGroupName("sandbox", "domain-a")).toBe(
      "/flex/domain/sandbox/domain-a/api-access",
    );
    expect(certificateParameterName("sandbox")).toBe(
      "/flex/domain/sandbox/certificate-arn",
    );
  });

  it("follow API Gateway's name for a stage's execution logs", () => {
    expect(apiExecutionLogGroupName("abc123", "live")).toBe(
      "API-Gateway-Execution-Logs_abc123/live",
    );
  });
});
