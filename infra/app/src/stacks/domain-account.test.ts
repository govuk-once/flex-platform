import { cdkApp, NETWORK_REGION } from "@repo/infra-constructs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../../test/helpers.ts";
import {
  DomainAccountStack,
  domainAccountStackName,
} from "./domain-account.ts";
import { networkStackName } from "./network.ts";

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
  it("is one per domain account, hosting domains or not, deployed after its network", () => {
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
        expect(stack.dependencies.map(({ id }) => id)).toContain(
          networkStackName(environment, domainAccount),
        );
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
      "AWS::IAM::ManagedPolicy",
      "AWS::IAM::Role",
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

  it("is in its domain account, in the network's region, protected from deletion", () => {
    const { stack } = build();

    expect(stack.stackName).toBe("domain-dev-main");
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

  it("reads the network's IDs, and outputs nothing", () => {
    const { Parameters, Outputs } = build().template.toJSON() as {
      Parameters: Record<string, { Default: string }>;
      Outputs?: Record<string, unknown>;
    };

    // Besides CDK's bootstrap check, each parameter is an SSM read, named by what it reads, since
    // CDK gives its ID a hash.
    const parameters = Object.entries(Parameters).map(([id, { Default }]) =>
      id === "BootstrapVersion" ? id : Default,
    );

    expect(parameters.toSorted()).toEqual([
      "/flex/network/dev/isolated-subnet-ids",
      "/flex/network/dev/security-group/domain",
      "BootstrapVersion",
    ]);
    expect(Object.keys(Outputs ?? {})).toEqual([]);
  });

  it("holds the deploy role to the network's IDs", () => {
    const { template } = build();
    const parameters = template.toJSON().Parameters as Record<
      string,
      { Default: string }
    >;
    const id = (name: string) =>
      Object.keys(parameters).find((key) => parameters[key]?.Default === name);
    const deny = (condition: Record<string, unknown>) =>
      Match.objectLike({ Effect: "Deny", Condition: condition });

    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "domain-dev-deploy",
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              deny({
                "ForAnyValue:StringNotEquals": {
                  "lambda:SubnetIds": {
                    Ref: id("/flex/network/dev/isolated-subnet-ids"),
                  },
                },
              }),
              deny({
                "ForAnyValue:StringNotEquals": {
                  "lambda:SecurityGroupIds": [
                    { Ref: id("/flex/network/dev/security-group/domain") },
                  ],
                },
              }),
            ]),
          },
        },
      ],
    });
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
