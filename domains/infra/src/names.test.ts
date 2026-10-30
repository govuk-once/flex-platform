import { describe, expect, it } from "vitest";

import {
  apiAccessLogGroupName,
  apiExecutionLogGroupName,
  certificateParameterName,
  deployRoleName,
  domainFunctionName,
  executionRoleName,
  functionLogGroupName,
} from "./names.ts";

describe("names", () => {
  it("name a domain's function from the environment's and the domain's names", () => {
    expect(domainFunctionName("sandbox", "domain-a")).toBe(
      "domain-sandbox-domain-a",
    );
  });

  it("name what every domain in an environment shares from the environment's name", () => {
    expect(executionRoleName("sandbox")).toBe("domain-sandbox-execution");
    expect(deployRoleName("sandbox")).toBe("domain-sandbox-deploy");
  });

  it("put the platform's log groups and parameters under /flex/domain", () => {
    expect(functionLogGroupName("sandbox")).toBe(
      "/flex/domain/sandbox/function",
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
