import { describe, expect, it } from "vitest";

import {
  apiAccessLogGroupName,
  apiExecutionLogGroupName,
  certificateParameterName,
  domainFunctionName,
  executionRoleName,
  functionLogGroupName,
  integrationRoleName,
  lambdaEndpointSecurityGroupParameterName,
  securityGroupParameterName,
  vpcIdParameterName,
} from "./names.ts";

describe("names", () => {
  it("name a domain's function from the environment's and the domain's names", () => {
    expect(domainFunctionName("sandbox", "domain-a")).toBe(
      "domain-sandbox-domain-a",
    );
  });

  it("name what every domain in an environment shares from the environment's name", () => {
    expect(executionRoleName("sandbox")).toBe("domain-sandbox-execution");
    expect(integrationRoleName("sandbox")).toBe("domain-sandbox-integration");
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
    expect(securityGroupParameterName("sandbox")).toBe(
      "/flex/domain/sandbox/security-group-id",
    );
  });

  it("read the VPC's hand-written parameters under /flex/network", () => {
    expect(vpcIdParameterName("sandbox")).toBe("/flex/network/sandbox/vpc-id");
    expect(lambdaEndpointSecurityGroupParameterName("sandbox")).toBe(
      "/flex/network/sandbox/lambda-endpoint-security-group-id",
    );
  });

  it("follow API Gateway's name for a stage's execution logs", () => {
    expect(apiExecutionLogGroupName("abc123", "live")).toBe(
      "API-Gateway-Execution-Logs_abc123/live",
    );
  });
});
