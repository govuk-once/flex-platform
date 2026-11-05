import { cdkApp, NETWORK_REGION } from "@repo/infra-constructs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../../test/helpers.ts";
import {
  DomainAccountStack,
  domainAccountStackName,
} from "./domain-account.ts";

const PROD = FIXTURE_STAGES[2];
const [DEV] = PROD.environments;
const [MAIN] = DEV.domainAccounts;

function build() {
  const stack = new DomainAccountStack(cdkApp(), {
    environment: DEV,
    domainAccount: MAIN,
  });
  return { stack, template: Template.fromStack(stack) };
}

describe("DomainAccountStack", () => {
  it("is one per domain account, hosting domains or not", () => {
    const assembly = synthesizedStage(PROD);

    for (const environment of PROD.environments) {
      for (const domainAccount of environment.domainAccounts) {
        const stack = assembly.getStackByName(
          domainAccountStackName(environment, domainAccount),
        );

        expect(stack.environment).toMatchObject({
          account: domainAccount.account,
          region: NETWORK_REGION,
        });
      }
    }
  });

  it("holds what every domain shares, and nothing per domain", () => {
    const resources = Object.values(
      build().template.toJSON().Resources as Record<string, { Type: string }>,
    ).map(({ Type }) => Type);

    expect(resources.toSorted()).toEqual([
      "AWS::ApiGateway::Account",
      "AWS::CertificateManager::Certificate",
      "AWS::IAM::Role",
      "AWS::Route53::RecordSet",
      "AWS::SSM::Parameter",
    ]);
  });

  it("names its stack from the environment and the domain account", () => {
    expect(domainAccountStackName(DEV, MAIN)).toBe("domainaccount-dev-main");
  });

  it("is in its domain account, in the network's region, protected from deletion", () => {
    const { stack } = build();

    expect(stack.stackName).toBe("domainaccount-dev-main");
    expect(stack.account).toBe(MAIN.account);
    expect(stack.region).toBe(NETWORK_REGION);
    expect(stack.terminationProtection).toBe(true);
  });

  it("builds the certificate in the account's zone, and writes its ARN to SSM", () => {
    const { template } = build();

    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: `*.${MAIN.zone.name}`,
      DomainValidationOptions: [
        { DomainName: `*.${MAIN.zone.name}`, HostedZoneId: MAIN.zone.id },
      ],
    });
    template.resourceCountIs("AWS::SSM::Parameter", 1);
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/flex/domain/dev/certificate-arn",
      Value: { Ref: Match.stringLikeRegexp("^ZoneCertificate") },
    });
  });

  it("reads nothing, and outputs nothing", () => {
    const { Parameters, Outputs } = build().template.toJSON() as {
      Parameters: Record<string, unknown>;
      Outputs?: Record<string, unknown>;
    };

    // CDK's bootstrap check is the stack's one parameter.
    expect(Object.keys(Parameters)).toEqual(["BootstrapVersion"]);
    expect(Object.keys(Outputs ?? {})).toEqual([]);
  });
});
