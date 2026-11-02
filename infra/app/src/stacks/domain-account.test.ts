import { cdkApp } from "@repo/infra-constructs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES } from "../../test/helpers.ts";
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
  it("holds what every domain shares, and nothing per domain", () => {
    const resources = Object.values(
      build().template.toJSON().Resources as Record<string, { Type: string }>,
    ).map(({ Type }) => Type);

    expect(resources.toSorted()).toEqual([
      "AWS::ApiGateway::Account",
      "AWS::CertificateManager::Certificate",
      "AWS::IAM::ManagedPolicy",
      "AWS::IAM::Role",
      "AWS::IAM::Role",
      "AWS::KMS::Key",
      "AWS::Logs::LogGroup",
      "AWS::Route53::RecordSet",
      "AWS::SSM::Parameter",
    ]);
  });

  it("names its stack from the environment and the domain account", () => {
    expect(domainAccountStackName(DEV, MAIN)).toBe("domain-dev-main");
  });

  it("is in its domain account, in eu-west-2, protected from deletion", () => {
    const { stack } = build();

    expect(stack.stackName).toBe("domain-dev-main");
    expect(stack.account).toBe(MAIN.account);
    expect(stack.region).toBe("eu-west-2");
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

  it("reads no parameter", () => {
    const parameters = Object.keys(
      build().template.toJSON().Parameters as object,
    );

    expect(parameters).toEqual(["BootstrapVersion"]);
  });

  it("creates the log group every domain's function logs to, named from config", () => {
    build().template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/flex/domain/dev/function",
    });
  });

  it("gives the execution role the log group's key", () => {
    build().template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "domain-dev-execution",
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: ["kms:Encrypt", "kms:GenerateDataKey*"],
                Resource: {
                  "Fn::GetAtt": [Match.stringLikeRegexp("^LogGroupKey"), "Arn"],
                },
              }),
            ]),
          },
        },
      ],
    });
  });

  it("lets the domains' functions invoke the environment's gateways", () => {
    build().template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "domain-dev-execution",
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: "lambda:InvokeFunction",
                Resource: `arn:aws:lambda:eu-west-2:${MAIN.account}:function:gateway-dev-*`,
              }),
            ]),
          },
        },
      ],
    });
  });
});
