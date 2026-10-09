import { Match, Template } from "aws-cdk-lib/assertions";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { describe, expect, it } from "vitest";

import { stackIn } from "../test/helpers.ts";
import {
  DEFAULT_MANAGED_RULE_GROUPS,
  RATE_LIMIT_RULE_NAME,
} from "./waf-rules.ts";
import { WebAcl, type WebAclProps } from "./web-acl.ts";

function build(overrides: Partial<WebAclProps> = {}, region = "us-east-1") {
  const stack = stackIn(region);
  const webAcl = new WebAcl(stack, "WebAcl", {
    environment: "sandbox",
    rateLimitPerFiveMinutes: 2000,
    logRetention: RetentionDays.THREE_MONTHS,
    ...overrides,
  });
  return { webAcl, template: Template.fromStack(stack) };
}

describe("WebAcl", () => {
  it("refuses any region but us-east-1", () => {
    expect(() => build({}, "eu-west-2")).toThrow("us-east-1");
  });

  it("is CloudFront scoped, named from config, and allows by default", () => {
    const { template } = build();

    template.resourceCountIs("AWS::WAFv2::WebACL", 1);
    template.hasResourceProperties("AWS::WAFv2::WebACL", {
      Name: "frontdoor-sandbox",
      Scope: "CLOUDFRONT",
      DefaultAction: { Allow: {} },
      VisibilityConfig: {
        CloudWatchMetricsEnabled: true,
        MetricName: "frontdoor-sandbox",
        SampledRequestsEnabled: true,
      },
    });
  });

  it("evaluates the managed rule groups in order, then the rate limit", () => {
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

  it("takes a different rule set and rate limit from config", () => {
    const { template } = build({
      managedRuleGroups: ["AWSManagedRulesKnownBadInputsRuleSet"],
      rateLimitPerFiveMinutes: 100,
    });

    template.hasResourceProperties("AWS::WAFv2::WebACL", {
      Rules: [
        Match.objectLike({ Name: "AWSManagedRulesKnownBadInputsRuleSet" }),
        Match.objectLike({
          Name: RATE_LIMIT_RULE_NAME,
          Priority: 1,
          Statement: {
            RateBasedStatement: Match.objectLike({ Limit: 100 }),
          },
        }),
      ],
    });
  });

  it("logs every evaluated request to a retained log group with credentials redacted", () => {
    const { template } = build();

    template.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
      Properties: {
        LogGroupName: "aws-waf-logs-frontdoor-sandbox",
        RetentionInDays: 90,
      },
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
  });
});
