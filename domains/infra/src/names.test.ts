import { describe, expect, it } from "vitest";

import {
  apiAccessLogGroupName,
  apiExecutionLogGroupName,
  domainHostName,
  domainLogGroupPattern,
  domainResourceName,
  functionLogGroupName,
} from "./names.ts";

const OPTIONS = { environment: "production" };

describe("names", () => {
  it("names a domain's function, role and API {section}-{environment}-{name}", () => {
    expect(domainResourceName("domain-one", OPTIONS)).toBe(
      "domain-production-domain-one",
    );
  });

  it("names a domain's log groups under /flex/{section}/{environment}/{name}", () => {
    expect(functionLogGroupName("domain-one", OPTIONS)).toBe(
      "/flex/domain/production/domain-one/function",
    );
    expect(apiAccessLogGroupName("domain-one", OPTIONS)).toBe(
      "/flex/domain/production/domain-one/api-access",
    );
  });

  it("covers every domain's log groups in an environment with one pattern", () => {
    const pattern = domainLogGroupPattern(OPTIONS);

    expect(pattern).toBe("/flex/domain/production/*");
    expect(
      functionLogGroupName("domain-one", OPTIONS).startsWith(
        pattern.slice(0, -1),
      ),
    ).toBe(true);
    expect(
      apiAccessLogGroupName("domain-one", OPTIONS).startsWith(
        pattern.slice(0, -1),
      ),
    ).toBe(true);
  });

  it("follows API Gateway's own name for a stage's execution logs", () => {
    expect(apiExecutionLogGroupName("a1b2c3d4e5", "prod")).toBe(
      "API-Gateway-Execution-Logs_a1b2c3d4e5/prod",
    );
  });

  it("puts a domain's host under its domain account's zone", () => {
    expect(
      domainHostName("domain-one", {
        zoneName: "production.flex-domain00.once.service.gov.uk",
      }),
    ).toBe("domain-one.production.flex-domain00.once.service.gov.uk");
  });
});
