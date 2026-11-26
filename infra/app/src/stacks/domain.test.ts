import { SIGNING_REGION } from "@repo/frontdoor-origin-request";
import { cdkApp } from "@repo/infra-constructs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../../test/helpers.ts";
import { DomainStack, domainStackName } from "./domain.ts";
import { domainAccountStackName } from "./domain-account.ts";
import { frontdoorStackName } from "./frontdoor.ts";
import { networkStackName } from "./network.ts";

const PROD = FIXTURE_STAGES[2];
const [DEV] = PROD.environments;
const [MAIN] = DEV.domainAccounts;
// One of the domains the fixtures list in every domain account that hosts any.
const DOMAIN = "domain-a";

function build() {
  const stack = new DomainStack(cdkApp(), {
    environment: DEV,
    domainAccount: MAIN,
    domain: DOMAIN,
    sharedAccount: PROD.shared.account,
  });
  return { stack, template: Template.fromStack(stack) };
}

describe("DomainStack", () => {
  it("is one per domain, in the account that hosts it, deployed after that account's network and stack and before the edge", () => {
    const assembly = synthesizedStage(PROD);

    for (const environment of PROD.environments) {
      const frontdoor = assembly
        .getStackByName(frontdoorStackName(environment))
        .dependencies.map(({ id }) => id);

      for (const domainAccount of environment.domainAccounts) {
        for (const { name: domain } of domainAccount.domains) {
          const stack = assembly.getStackByName(
            domainStackName(environment, domain),
          );

          expect(stack.environment).toMatchObject({
            account: domainAccount.account,
            region: SIGNING_REGION,
          });
          expect(stack.dependencies.map(({ id }) => id)).toEqual(
            expect.arrayContaining([
              networkStackName(environment, domainAccount),
              domainAccountStackName(environment, domainAccount),
            ]),
          );
          expect(frontdoor).toContain(domainStackName(environment, domain));
        }
      }
    }
  });

  it("holds one domain's API, its alarms, host, log group and roles, and nothing shared", () => {
    const resources = Object.values(
      build().template.toJSON().Resources as Record<string, { Type: string }>,
    ).map(({ Type }) => Type);

    expect(resources.toSorted()).toEqual([
      "AWS::ApiGateway::BasePathMapping",
      "AWS::ApiGateway::Deployment",
      "AWS::ApiGateway::DomainName",
      "AWS::ApiGateway::GatewayResponse",
      "AWS::ApiGateway::GatewayResponse",
      "AWS::ApiGateway::GatewayResponse",
      "AWS::ApiGateway::GatewayResponse",
      "AWS::ApiGateway::GatewayResponse",
      "AWS::ApiGateway::GatewayResponse",
      "AWS::ApiGateway::GatewayResponse",
      "AWS::ApiGateway::GatewayResponse",
      "AWS::ApiGateway::Method",
      "AWS::ApiGateway::Method",
      "AWS::ApiGateway::Resource",
      "AWS::ApiGateway::RestApi",
      "AWS::ApiGateway::Stage",
      "AWS::CloudWatch::Alarm",
      "AWS::CloudWatch::Alarm",
      "AWS::IAM::ManagedPolicy",
      "AWS::IAM::Role",
      "AWS::IAM::Role",
      "AWS::IAM::Role",
      "AWS::KMS::Key",
      "AWS::Logs::LogGroup",
      "AWS::Logs::LogGroup",
      "AWS::Logs::LogGroup",
      "AWS::Logs::MetricFilter",
      "AWS::Logs::MetricFilter",
      "AWS::Route53::RecordSet",
    ]);
  });

  it("names its stack from the environment and the domain", () => {
    expect(domainStackName(DEV, DOMAIN)).toBe("domain-dev-domain-a");
  });

  it("is in the domain's account, in the region the edge signs requests for, protected from deletion", () => {
    const { stack } = build();

    expect(stack.stackName).toBe("domain-dev-domain-a");
    expect(stack.account).toBe(MAIN.account);
    expect(stack.region).toBe(SIGNING_REGION);
    expect(stack.terminationProtection).toBe(true);
  });

  it("reads the account's certificate and the network's IDs, and outputs nothing", () => {
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
      "/flex/domain/dev/certificate-arn",
      "/flex/network/dev/endpoint/lambda",
      "/flex/network/dev/isolated-subnet-ids",
      "/flex/network/dev/security-group/domain",
      "BootstrapVersion",
    ]);
    expect(Object.keys(Outputs ?? {})).toEqual([]);
  });

  it("answers at the domain's host under its account's zone, with the account's certificate", () => {
    const template = Template.fromStack(build().stack);
    const parameters = template.toJSON().Parameters as Record<
      string,
      { Default: string }
    >;
    const certificateArn = Object.keys(parameters).find(
      (id) => parameters[id]?.Default === "/flex/domain/dev/certificate-arn",
    );

    template.hasResourceProperties("AWS::ApiGateway::DomainName", {
      DomainName: `${DOMAIN}.${MAIN.zone.name}`,
      RegionalCertificateArn: { Ref: certificateArn },
    });
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      HostedZoneId: MAIN.zone.id,
    });
  });

  it("lets in only the environment's edge role, from the frontdoor account", () => {
    const edgeRole = `arn:aws:iam::${DEV.frontdoor.account}:role/frontdoor-dev-edge`;

    Template.fromStack(build().stack).hasResourceProperties(
      "AWS::ApiGateway::RestApi",
      {
        Policy: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Principal: { AWS: `arn:aws:iam::${DEV.frontdoor.account}:root` },
              Condition: { ArnEquals: { "aws:PrincipalArn": edgeRole } },
            }),
          ]),
        },
      },
    );
  });

  it("lets only the stage's release worker, in the shared account, assume the deploy role", () => {
    Template.fromStack(build().stack).hasResourceProperties("AWS::IAM::Role", {
      RoleName: "domain-dev-domain-a-deploy",
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { AWS: `arn:aws:iam::${PROD.shared.account}:root` },
            Condition: {
              ArnEquals: {
                "aws:PrincipalArn": `arn:aws:iam::${PROD.shared.account}:role/shared-release-worker`,
              },
            },
          }),
        ],
      },
    });
  });

  // The bucket the pipeline API uploads to, so Lambda can read a bundle as the deploy role.
  it("lets the deploy role read its own domain's bundles in the shared account's code bucket", () => {
    Template.fromStack(build().stack).hasResourceProperties("AWS::IAM::Role", {
      RoleName: "domain-dev-domain-a-deploy",
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Effect: "Allow",
                Action: ["s3:GetObject", "s3:GetObjectVersion"],
                Resource: `arn:aws:s3:::shared-domain-code-${PROD.shared.account}/domain-a/bundle/*.zip`,
              },
            ]),
          },
        },
      ],
    });
  });

  it("holds the deploy role to the network's IDs", () => {
    const template = Template.fromStack(build().stack);
    const parameters = template.toJSON().Parameters as Record<
      string,
      { Default: string }
    >;
    const id = (name: string) =>
      Object.keys(parameters).find((key) => parameters[key]?.Default === name);
    const deny = (condition: Record<string, unknown>) =>
      Match.objectLike({ Effect: "Deny", Condition: condition });

    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "domain-dev-domain-a-deploy",
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

  it("creates the log group the domain's function logs to, named from config", () => {
    Template.fromStack(build().stack).hasResourceProperties(
      "AWS::Logs::LogGroup",
      {
        LogGroupName: "/flex/domain/dev/domain-a/function",
      },
    );
  });

  it("gives the execution role the log group's key", () => {
    Template.fromStack(build().stack).hasResourceProperties("AWS::IAM::Role", {
      RoleName: "domain-dev-domain-a-execution",
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

  it("lets the domain's function invoke the environment's gateways, by their live alias and through the network's lambda endpoint alone", () => {
    const template = Template.fromStack(build().stack);
    const parameters = template.toJSON().Parameters as Record<
      string,
      { Default: string }
    >;
    const endpoint = Object.keys(parameters).find(
      (key) => parameters[key]?.Default === "/flex/network/dev/endpoint/lambda",
    );

    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "domain-dev-domain-a-execution",
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: "lambda:InvokeFunction",
                Effect: "Allow",
                Resource: `arn:aws:lambda:eu-west-2:${MAIN.account}:function:gateway-dev-*:live`,
              }),
              Match.objectLike({
                Action: "lambda:InvokeFunction",
                Effect: "Deny",
                Resource: "*",
                Condition: {
                  StringNotEquals: { "aws:SourceVpce": { Ref: endpoint } },
                },
              }),
            ]),
          },
        },
      ],
    });
  });
});
