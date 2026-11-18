import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES } from "../../test/helpers.ts";
import { functionReaders, releaseTargets } from "./release-targets.ts";
import type { StageConfig } from "./types.ts";

const [DEV_STAGE, , PROD] = FIXTURE_STAGES;

describe("releaseTargets", () => {
  it("names everything a release of each registered domain does, where a pipeline publishes", () => {
    expect(releaseTargets(PROD)).toEqual([
      {
        environment: "dev",
        domain: "domain-a",
        deployRoleArn:
          "arn:aws:iam::300000000003:role/domain-dev-domain-a-deploy",
        functionName: "domain-dev-domain-a",
        executionRoleArn:
          "arn:aws:iam::300000000003:role/domain-dev-domain-a-execution",
        logGroupName: "/flex/domain/dev/domain-a/function",
        subnetIdsParameter: "/flex/network/dev/isolated-subnet-ids",
        securityGroupIdParameter: "/flex/network/dev/security-group/domain",
      },
    ]);
  });

  // domain-b is hosted, but has no repository to ask for its release.
  it("leaves out a domain with no repository", () => {
    expect(releaseTargets(DEV_STAGE).map(({ domain }) => domain)).toEqual([
      "domain-a",
    ]);
  });

  it("takes a disabled domain, whose code can be released while nothing is routed to it", () => {
    const [environment] = DEV_STAGE.environments;
    const [account] = environment.domainAccounts;
    const stage: StageConfig = {
      ...DEV_STAGE,
      environments: [
        {
          ...environment,
          domainAccounts: [
            { ...account, domains: [{ name: "domain-a", disabled: true }] },
          ],
        },
      ],
    };

    expect(releaseTargets(stage).map(({ domain }) => domain)).toEqual([
      "domain-a",
    ]);
  });
});

describe("functionReaders", () => {
  it("names each domain account where a pipeline publishes, and its environment's functions", () => {
    expect(functionReaders(PROD)).toEqual([
      { account: "300000000003", functionNames: "domain-dev-*" },
    ]);
  });
});
