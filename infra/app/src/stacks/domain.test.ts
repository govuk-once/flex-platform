import { SIGNING_REGION } from "@repo/frontdoor-origin-request";
import { cdkApp } from "@repo/infra-constructs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES } from "../../test/helpers.ts";
import { DomainStack, domainStackName } from "./domain.ts";

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
  });
  return { stack, template: Template.fromStack(stack) };
}

describe("DomainStack", () => {
  it("holds one domain's API and host, and nothing shared", () => {
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
      "AWS::IAM::Role",
      "AWS::KMS::Key",
      "AWS::Logs::LogGroup",
      "AWS::Logs::LogGroup",
      "AWS::Route53::RecordSet",
    ]);
  });

  it("names its stack from the environment and the domain", () => {
    expect(domainStackName(DEV, DOMAIN)).toBe("domain-dev-domain-a");
  });

  it("is in the domain's account, in the region the edge signs requests for, and can be removed with the domain", () => {
    const { stack } = build();

    expect(stack.stackName).toBe("domain-dev-domain-a");
    expect(stack.account).toBe(MAIN.account);
    expect(stack.region).toBe(SIGNING_REGION);
    expect(stack.terminationProtection).toBe(false);
  });

  it("reads the account's certificate, and outputs nothing", () => {
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
      "BootstrapVersion",
    ]);
    expect(Object.keys(Outputs ?? {})).toEqual([]);
  });

  it("answers at the domain's host under its account's zone, with the account's certificate", () => {
    const { template } = build();
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

    build().template.hasResourceProperties("AWS::ApiGateway::RestApi", {
      Policy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${DEV.frontdoor.account}:root` },
            Condition: { ArnEquals: { "aws:PrincipalArn": edgeRole } },
          }),
        ]),
      },
    });
  });
});
