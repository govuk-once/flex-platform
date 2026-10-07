import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { describe, expect, it } from "vitest";

import {
  EdgeWebAcl,
  type EdgeWebAclProps,
} from "../../src/constructs/edge-web-acl.ts";
import {
  DEFAULT_MANAGED_RULE_GROUPS,
  RATE_LIMIT_RULE_NAME,
} from "../../src/constructs/waf-rules.ts";

function build(overrides: Partial<EdgeWebAclProps> = {}, region = "us-east-1") {
  const stack = new Stack(new App(), "Test", {
    env: { account: "123456789012", region },
  });
  const webAcl = new EdgeWebAcl(stack, "WebAcl", {
    name: "test-flex-edge",
    rateLimit: { requestsPerWindow: 2000 },
    logRetention: RetentionDays.THREE_MONTHS,
    retainLogsOnDelete: true,
    ...overrides,
  });
  return { webAcl, template: Template.fromStack(stack) };
}

describe("EdgeWebAcl", () => {
  it("refuses any region but us-east-1, the one CloudFront takes a web ACL from", () => {
    expect(() => build({}, "eu-west-2")).toThrow("us-east-1");
  });

  it("is CloudFront scoped and allows by default", () => {
    const { template } = build();

    template.resourceCountIs("AWS::WAFv2::WebACL", 1);
    template.hasResourceProperties("AWS::WAFv2::WebACL", {
      Name: "test-flex-edge",
      Scope: "CLOUDFRONT",
      DefaultAction: { Allow: {} },
      VisibilityConfig: {
        CloudWatchMetricsEnabled: true,
        MetricName: "test-flex-edge",
        SampledRequestsEnabled: true,
      },
    });
  });

  it("evaluates the agreed managed rule groups in order, then the rate limit", () => {
    const { template, webAcl } = build();
    const [resource] = Object.values(
      template.findResources("AWS::WAFv2::WebACL"),
    );
    const rules = (
      resource?.Properties as {
        Rules: {
          Name: string;
          Priority: number;
          Statement: Record<string, unknown>;
          Action?: unknown;
          OverrideAction?: unknown;
        }[];
      }
    ).Rules;

    expect(rules.map((rule) => rule.Name)).toEqual([
      ...DEFAULT_MANAGED_RULE_GROUPS,
      RATE_LIMIT_RULE_NAME,
    ]);
    expect(webAcl.ruleNames).toEqual(rules.map((rule) => rule.Name));
    expect(rules.map((rule) => rule.Priority)).toEqual([0, 1, 2, 3, 4]);
    for (const rule of rules.slice(0, -1)) {
      expect(rule.OverrideAction).toEqual({ None: {} });
      expect(rule.Statement.ManagedRuleGroupStatement).toMatchObject({
        VendorName: "AWS",
        Name: rule.Name,
      });
    }
    expect(rules.at(-1)).toMatchObject({
      Action: { Block: { CustomResponse: { ResponseCode: 429 } } },
      Statement: {
        RateBasedStatement: {
          Limit: 2000,
          EvaluationWindowSec: 300,
          AggregateKeyType: "IP",
        },
      },
    });
  });

  it("takes a different rule set and rate limit when told", () => {
    const { template } = build({
      managedRuleGroups: ["AWSManagedRulesKnownBadInputsRuleSet"],
      rateLimit: {
        requestsPerWindow: 100,
        windowSeconds: 60,
        responseCode: 403,
      },
    });

    template.hasResourceProperties("AWS::WAFv2::WebACL", {
      Rules: [
        Match.objectLike({ Name: "AWSManagedRulesKnownBadInputsRuleSet" }),
        Match.objectLike({
          Name: RATE_LIMIT_RULE_NAME,
          Priority: 1,
          Action: { Block: { CustomResponse: { ResponseCode: 403 } } },
          Statement: {
            RateBasedStatement: Match.objectLike({
              Limit: 100,
              EvaluationWindowSec: 60,
            }),
          },
        }),
      ],
    });
  });

  it("logs every evaluated request to an encrypted, retained log group with credentials redacted", () => {
    const { template, webAcl } = build();

    expect(webAcl.logGroupName).toBe("aws-waf-logs-test-flex-edge");
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "aws-waf-logs-test-flex-edge",
      RetentionInDays: 90,
      KmsKeyId: Match.anyValue(),
    });
    template.hasResourceProperties("AWS::WAFv2::LoggingConfiguration", {
      ResourceArn: { "Fn::GetAtt": [Match.stringLikeRegexp("WebAcl"), "Arn"] },
      LogDestinationConfigs: [
        {
          "Fn::Join": [
            "",
            [
              "arn:",
              { Ref: "AWS::Partition" },
              ":logs:us-east-1:123456789012:log-group:",
              { Ref: Match.stringLikeRegexp("LogGroup") },
            ],
          ],
        },
      ],
      RedactedFields: [
        { SingleHeader: { Name: "authorization" } },
        { SingleHeader: { Name: "cookie" } },
      ],
    });
    template.hasResourceProperties("AWS::WAFv2::WebACL", {
      DataProtectionConfig: {
        DataProtections: Match.arrayWith([
          Match.objectLike({
            Action: "SUBSTITUTION",
            Field: { FieldType: "SINGLE_HEADER", FieldKeys: ["authorization"] },
          }),
        ]),
      },
    });
    template.hasResourceProperties("AWS::KMS::Key", {
      EnableKeyRotation: true,
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "AllowCloudWatchLogs",
            Principal: { Service: "logs.us-east-1.amazonaws.com" },
          }),
        ]),
      },
    });
  });

  it("removes an ephemeral stage's log group and key with its stack", () => {
    const { template } = build({ retainLogsOnDelete: false });

    template.hasResource("AWS::Logs::LogGroup", { DeletionPolicy: "Delete" });
    template.hasResource("AWS::KMS::Key", { DeletionPolicy: "Delete" });
  });
});
