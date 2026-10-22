import { cdkApp } from "@repo/infra-constructs";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../../test/helpers.ts";
import { DOMAIN_REGION } from "./domain.ts";
import {
  DomainAccountStack,
  domainAccountStackName,
} from "./domain-account.ts";

const PROD = FIXTURE_STAGES[2];
const [, , PROD_ENVIRONMENT] = PROD.environments;
const [MAIN, SECOND] = PROD_ENVIRONMENT.domainAccounts;
const [, STAGING] = FIXTURE_STAGES;
const [STAGING_SANDBOX] = STAGING.environments;

describe("DomainAccountStack", () => {
  it("is one per domain account that hosts a domain in the environment, in that account, with termination protection", () => {
    const assembly = synthesizedStage(PROD);

    for (const environment of PROD.environments) {
      for (const domainAccount of environment.domainAccounts) {
        const stack = assembly.getStackByName(
          domainAccountStackName(environment, domainAccount),
        );

        expect(stack.environment).toMatchObject({
          account: domainAccount.account,
          region: DOMAIN_REGION,
        });
        expect(stack.terminationProtection).toBe(true);
      }
    }
  });

  // Gating: an account holds nothing in an environment that lists none of its domains.
  it("isn't built where the environment hosts none of the account's domains", () => {
    const [domainAccount] = STAGING_SANDBOX.domainAccounts;

    expect(
      synthesizedStage(STAGING).stacks.map(({ stackName }) => stackName),
    ).not.toContain(domainAccountStackName(STAGING_SANDBOX, domainAccount));
  });

  it("builds a host for each domain the environment hosts in the account, and no other", () => {
    const main = Template.fromStack(
      new DomainAccountStack(cdkApp(), {
        environment: PROD_ENVIRONMENT,
        domainAccount: MAIN,
      }),
    );
    const second = Template.fromStack(
      new DomainAccountStack(cdkApp(), {
        environment: PROD_ENVIRONMENT,
        domainAccount: SECOND,
      }),
    );

    main.resourceCountIs("AWS::ApiGateway::DomainName", 1);
    main.hasResourceProperties("AWS::ApiGateway::DomainName", {
      DomainName: `domain-one.${MAIN.zone.name}`,
    });
    main.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: `*.${MAIN.zone.name}`,
      DomainValidationOptions: [
        { DomainName: `*.${MAIN.zone.name}`, HostedZoneId: MAIN.zone.id },
      ],
    });

    second.resourceCountIs("AWS::ApiGateway::DomainName", 1);
    second.hasResourceProperties("AWS::ApiGateway::DomainName", {
      DomainName: `domain-two.${SECOND.zone.name}`,
    });
  });

  it("names its stack from the environment and the account", () => {
    expect(domainAccountStackName(PROD_ENVIRONMENT, MAIN)).toBe(
      "domain-prod-main-account",
    );
  });
});
