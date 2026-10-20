import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { stackIn } from "../test/helpers.ts";
import { WebAcl } from "./web-acl.ts";

interface Rule {
  Name: string;
  Priority: number;
  Statement: Record<string, unknown>;
  Action?: unknown;
  OverrideAction?: unknown;
}

function build(region = "us-east-1") {
  const stack = stackIn(region);
  const webAcl = new WebAcl(stack, "WebAcl", { environment: "sandbox" });
  return { webAcl, template: Template.fromStack(stack) };
}

function webAclProperties(template: Template) {
  const [resource] = Object.values(
    template.findResources("AWS::WAFv2::WebACL"),
  );
  return resource?.Properties as {
    Rules: Rule[];
    CustomResponseBodies: Record<string, unknown>;
  };
}

function rules(template: Template): Rule[] {
  return webAclProperties(template).Rules;
}

function rule(template: Template, name: string): Rule {
  const found = rules(template).find((candidate) => candidate.Name === name);
  if (found === undefined) throw new Error(`No rule named ${name}`);
  return found;
}

function responseBody(template: Template, key: string): unknown {
  return webAclProperties(template).CustomResponseBodies[key];
}

describe("WebAcl", () => {
  it("refuses any region but us-east-1", () => {
    expect(() => build("eu-west-2")).toThrow("us-east-1");
  });

  it("is CloudFront scoped, named from config, and allows by default", () => {
    const { template } = build();

    template.resourceCountIs("AWS::WAFv2::WebACL", 1);
    template.hasResourceProperties("AWS::WAFv2::WebACL", {
      Name: "frontdoor-sandbox-web-acl",
      Scope: "CLOUDFRONT",
      DefaultAction: { Allow: {} },
      VisibilityConfig: {
        CloudWatchMetricsEnabled: true,
        MetricName: "frontdoor-sandbox-web-acl",
        SampledRequestsEnabled: true,
      },
    });
  });

  it("evaluates the body size limit, the managed rule groups, then the rate limits", () => {
    const { webAcl, template } = build();

    expect(webAcl.ruleNames).toEqual([
      "BodySizeLimit",
      "AWSManagedRulesCommonRuleSet",
      "AWSManagedRulesKnownBadInputsRuleSet",
      "AWSManagedRulesSQLiRuleSet",
      "AWSManagedRulesAnonymousIpList",
      "RateLimitPerToken",
      "RateLimitPerIp",
    ]);
    expect(rules(template).map((rule) => rule.Name)).toEqual(webAcl.ruleNames);
    expect(rules(template).map((rule) => rule.Priority)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it("answers a body over 16 KB with a 413, including one too large to inspect", () => {
    const { template } = build();

    template.hasResourceProperties("AWS::WAFv2::WebACL", {
      AssociationConfig: {
        RequestBody: { CLOUDFRONT: { DefaultSizeInspectionLimit: "KB_16" } },
      },
    });
    expect(rule(template, "BodySizeLimit")).toMatchObject({
      Action: {
        Block: {
          CustomResponse: {
            ResponseCode: 413,
            CustomResponseBodyKey: "body-too-large",
          },
        },
      },
      Statement: {
        SizeConstraintStatement: {
          FieldToMatch: { Body: { OversizeHandling: "MATCH" } },
          ComparisonOperator: "GT",
          Size: 16384,
        },
      },
    });
    expect(responseBody(template, "body-too-large")).toEqual({
      ContentType: "APPLICATION_JSON",
      Content: '{"message":"Request body too large","type":"client_error"}',
    });
  });

  it("keeps the managed rule groups' own actions, except the two it counts", () => {
    const { template } = build();

    for (const name of [
      "AWSManagedRulesCommonRuleSet",
      "AWSManagedRulesKnownBadInputsRuleSet",
      "AWSManagedRulesSQLiRuleSet",
    ]) {
      expect(rule(template, name)).toMatchObject({
        OverrideAction: { None: {} },
        Statement: {
          ManagedRuleGroupStatement: { VendorName: "AWS", Name: name },
        },
      });
    }
    // The body size limit decides bodies, so the common rule set's 8 KB limit only counts.
    expect(
      rule(template, "AWSManagedRulesCommonRuleSet").Statement
        .ManagedRuleGroupStatement,
    ).toMatchObject({
      RuleActionOverrides: [
        { Name: "SizeRestrictions_BODY", ActionToUse: { Count: {} } },
      ],
    });
    expect(rule(template, "AWSManagedRulesAnonymousIpList")).toMatchObject({
      OverrideAction: { Count: {} },
    });
    expect(rules(template).map((rule) => rule.Name)).not.toContain(
      "AWSManagedRulesAmazonIpReputationList",
    );
  });

  it("limits each token to 1,000 requests and each address to 5,000 in five minutes, with a 429", () => {
    const { template } = build();
    const tooManyRequests = {
      Block: {
        CustomResponse: {
          ResponseCode: 429,
          CustomResponseBodyKey: "too-many-requests",
        },
      },
    };

    expect(rule(template, "RateLimitPerToken")).toMatchObject({
      Action: tooManyRequests,
      Statement: {
        RateBasedStatement: {
          Limit: 1000,
          EvaluationWindowSec: 300,
          AggregateKeyType: "CUSTOM_KEYS",
          CustomKeys: [
            {
              Header: {
                Name: "authorization",
                TextTransformations: [{ Priority: 0, Type: "NONE" }],
              },
            },
          ],
        },
      },
    });
    expect(rule(template, "RateLimitPerIp")).toMatchObject({
      Action: tooManyRequests,
      Statement: {
        RateBasedStatement: {
          Limit: 5000,
          EvaluationWindowSec: 300,
          AggregateKeyType: "IP",
        },
      },
    });
    expect(responseBody(template, "too-many-requests")).toEqual({
      ContentType: "APPLICATION_JSON",
      Content: '{"message":"Too many requests","type":"client_error"}',
    });
  });

  it("logs every evaluated request to a retained log group with credentials redacted", () => {
    const { template } = build();

    template.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
      Properties: {
        LogGroupName: "aws-waf-logs-frontdoor-sandbox-web-acl",
        RetentionInDays: 365,
      },
    });
    template.hasResourceProperties("AWS::WAFv2::LoggingConfiguration", {
      ResourceArn: { "Fn::GetAtt": [Match.stringLikeRegexp("WebAcl"), "Arn"] },
      LogDestinationConfigs: [
        {
          "Fn::Join": [
            "",
            [
              "arn:aws:logs:us-east-1:123456789012:log-group:",
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
