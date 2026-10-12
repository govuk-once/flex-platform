import { Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";

import {
  countResourcesByType,
  createTestStack,
  DOMAIN_ACCOUNT,
  ENVIRONMENT,
  HOSTED_ZONE_ID,
  REGION,
  ZONE_NAME,
} from "../test/helpers.ts";
import type { DomainAccountProps } from "./domain-account.ts";
import { DomainAccount } from "./domain-account.ts";

const PROPS: DomainAccountProps = {
  environment: ENVIRONMENT,
  zone: { zoneName: ZONE_NAME, hostedZoneId: HOSTED_ZONE_ID },
  domainNames: ["domain-one", "domain-two"],
};

function synthTemplate(overrides: Partial<DomainAccountProps> = {}): Template {
  const { stack } = createTestStack();

  new DomainAccount(stack, "DomainAccount", { ...PROPS, ...overrides });

  return Template.fromStack(stack);
}

function logicalIds(template: Template): string[] {
  const { Resources } = template.toJSON() as {
    Resources: Record<string, unknown>;
  };

  return Object.keys(Resources).sort();
}

function logGroupArn(resourceName: string): string {
  return `arn:aws:logs:${REGION}:${DOMAIN_ACCOUNT}:log-group:${resourceName}`;
}

describe("DomainAccount", () => {
  const template = synthTemplate();

  it("creates the certificate, a host per domain and API Gateway's logging role, and nothing broader", () => {
    expect(countResourcesByType(template)).toEqual({
      "AWS::ApiGateway::Account": 1,
      "AWS::ApiGateway::DomainName": 2,
      "AWS::CertificateManager::Certificate": 1,
      "AWS::IAM::Role": 1,
      // The zone's CAA record, and an alias per domain.
      "AWS::Route53::RecordSet": 3,
    });
  });

  describe("certificate", () => {
    it("is one wildcard for the zone, validated in the zone by DNS", () => {
      template.hasResourceProperties("AWS::CertificateManager::Certificate", {
        DomainName: `*.${ZONE_NAME}`,
        ValidationMethod: "DNS",
        DomainValidationOptions: [
          { DomainName: `*.${ZONE_NAME}`, HostedZoneId: HOSTED_ZONE_ID },
        ],
      });
    });

    it("lets only Amazon issue for the zone, before the certificate is requested", () => {
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: `${ZONE_NAME}.`,
        Type: "CAA",
        HostedZoneId: HOSTED_ZONE_ID,
      });

      template.hasResource("AWS::CertificateManager::Certificate", {
        DependsOn: [Match.stringLikeRegexp("^DomainAccountCaa")],
      });
    });
  });

  describe("hosts", () => {
    it.each(["domain-one", "domain-two"])(
      "gives %s a regional API Gateway domain name under the zone, on TLS 1.2 and the wildcard",
      (domainName) => {
        template.hasResourceProperties("AWS::ApiGateway::DomainName", {
          DomainName: `${domainName}.${ZONE_NAME}`,
          EndpointConfiguration: { Types: ["REGIONAL"] },
          SecurityPolicy: "TLS_1_2",
          RegionalCertificateArn: {
            Ref: Match.stringLikeRegexp("^DomainAccountCertificate"),
          },
        });
      },
    );

    it("points each host's name at its API Gateway domain name", () => {
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: `domain-one.${ZONE_NAME}.`,
        Type: "A",
        HostedZoneId: HOSTED_ZONE_ID,
        AliasTarget: {
          DNSName: {
            "Fn::GetAtt": [
              Match.stringLikeRegexp("^DomainAccountdomainoneDomainName"),
              "RegionalDomainName",
            ],
          },
          HostedZoneId: {
            "Fn::GetAtt": [
              Match.stringLikeRegexp("^DomainAccountdomainoneDomainName"),
              "RegionalHostedZoneId",
            ],
          },
        },
      });
    });

    // Promoting a domain into an environment must replace nothing already there.
    it("keeps every other resource's logical ID when a domain is added", () => {
      const before = synthTemplate({ domainNames: ["domain-one"] });

      expect(logicalIds(template)).toEqual(
        expect.arrayContaining(logicalIds(before)),
      );
    });

    it("gives the same logical IDs whatever order the domains are in", () => {
      const reversed = synthTemplate({
        domainNames: [...PROPS.domainNames].reverse(),
      });

      expect(logicalIds(reversed)).toEqual(logicalIds(template));
    });
  });

  describe("API Gateway's logging", () => {
    it("sets the account's CloudWatch role", () => {
      template.hasResourceProperties("AWS::ApiGateway::Account", {
        CloudWatchRoleArn: {
          "Fn::GetAtt": [
            Match.stringLikeRegexp("^DomainAccountApiGatewayLogsRole"),
            "Arn",
          ],
        },
      });
    });

    it("lets API Gateway write only to the environment's domain log groups and execution logs", () => {
      template.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: "sts:AssumeRole",
              Effect: "Allow",
              Principal: { Service: "apigateway.amazonaws.com" },
            },
          ],
        },
        ManagedPolicyArns: Match.absent(),
        Policies: [
          {
            PolicyName: "WriteLogs",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                Match.objectEquals({
                  Effect: "Allow",
                  Action: [
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:DescribeLogStreams",
                    "logs:FilterLogEvents",
                    "logs:GetLogEvents",
                    "logs:PutLogEvents",
                  ],
                  Resource: [
                    logGroupArn(`/flex/domain/${ENVIRONMENT}/*:*`),
                    logGroupArn("API-Gateway-Execution-Logs_*:*"),
                  ],
                }),
                Match.objectEquals({
                  Effect: "Allow",
                  Action: "logs:DescribeLogGroups",
                  Resource: logGroupArn("*:*"),
                }),
              ],
            },
          },
        ],
      });
    });
  });

  // The app runs cdk-nag on every stack.
  it("passes the AWS Solutions checks", () => {
    const { app, stack } = createTestStack();

    Validations.of(app).addPlugins(new AwsSolutionsChecks(app));

    new DomainAccount(stack, "DomainAccount", PROPS);

    expect(() => app.synth()).not.toThrow();
  });
});
