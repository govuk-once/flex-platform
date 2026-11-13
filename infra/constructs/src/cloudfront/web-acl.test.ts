import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { stackIn } from "../../test/cloudfront.ts";
import { CloudFrontWebAcl, wafLogGroupName } from "./web-acl.ts";

interface Rule {
  Name: string;
  Priority: number;
  Statement: Record<string, unknown>;
  Action?: unknown;
  OverrideAction?: unknown;
}

function build(region = "us-east-1", checks = false) {
  const { app, stack } = stackIn(region, checks);
  const webAcl = new CloudFrontWebAcl(stack, "WebAcl", {
    name: "example-web-acl",
    tokenHeader: "x-example-token",
    rateLimitPerToken: 100,
    rateLimitPerIp: 500,
    redactedHeaders: ["x-example-token", "cookie"],
  });
  return { app, webAcl, template: () => Template.fromStack(stack) };
}

function rules(template: Template): Rule[] {
  const [resource] = Object.values(
    template.findResources("AWS::WAFv2::WebACL"),
  );
  return (resource?.Properties as { Rules: Rule[] }).Rules;
}

function rule(template: Template, name: string): Rule {
  const found = rules(template).find((candidate) => candidate.Name === name);
  if (found === undefined) throw new Error(`No rule named ${name}`);
  return found;
}

describe("wafLogGroupName", () => {
  it("starts with the prefix WAF requires", () => {
    expect(wafLogGroupName("example-web-acl")).toBe(
      "aws-waf-logs-example-web-acl",
    );
  });
});

describe("CloudFrontWebAcl", () => {
  it("refuses any region but us-east-1", () => {
    expect(() => build("eu-west-2")).toThrow("us-east-1");
  });

  it("passes cdk-nag and the platform's log group check", () => {
    expect(() => build("us-east-1", true).app.synth()).not.toThrow();
  });

  it("is CloudFront scoped, named as it is given, and allows by default", () => {
    build()
      .template()
      .hasResourceProperties("AWS::WAFv2::WebACL", {
        Name: "example-web-acl",
        Scope: "CLOUDFRONT",
        DefaultAction: { Allow: {} },
        VisibilityConfig: {
          CloudWatchMetricsEnabled: true,
          MetricName: "example-web-acl",
          SampledRequestsEnabled: true,
        },
      });
  });

  it("evaluates the body size limit, the managed rule groups, then the rate limits", () => {
    const { webAcl, template } = build();
    const built = template();

    expect(webAcl.ruleNames).toEqual([
      "BodySizeLimit",
      "AWSManagedRulesCommonRuleSet",
      "AWSManagedRulesKnownBadInputsRuleSet",
      "AWSManagedRulesSQLiRuleSet",
      "AWSManagedRulesAnonymousIpList",
      "RateLimitPerToken",
      "RateLimitPerIp",
    ]);
    expect(rules(built).map(({ Name }) => Name)).toEqual(webAcl.ruleNames);
    expect(rules(built).map(({ Priority }) => Priority)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it("answers a body over 16 KB with a 413, including one too large to inspect", () => {
    const built = build().template();

    built.hasResourceProperties("AWS::WAFv2::WebACL", {
      AssociationConfig: {
        RequestBody: { CLOUDFRONT: { DefaultSizeInspectionLimit: "KB_16" } },
      },
      CustomResponseBodies: {
        "body-too-large": {
          ContentType: "APPLICATION_JSON",
          Content: '{"message":"Request body too large","type":"client_error"}',
        },
        "too-many-requests": {
          ContentType: "APPLICATION_JSON",
          Content: '{"message":"Too many requests","type":"client_error"}',
        },
      },
    });
    expect(rule(built, "BodySizeLimit")).toMatchObject({
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
  });

  it("keeps the managed rule groups' own actions, except the two it counts", () => {
    const built = build().template();

    expect(rule(built, "AWSManagedRulesCommonRuleSet")).toMatchObject({
      OverrideAction: { None: {} },
      Statement: {
        ManagedRuleGroupStatement: {
          RuleActionOverrides: [
            { Name: "SizeRestrictions_BODY", ActionToUse: { Count: {} } },
          ],
        },
      },
    });
    for (const name of [
      "AWSManagedRulesKnownBadInputsRuleSet",
      "AWSManagedRulesSQLiRuleSet",
    ]) {
      expect(rule(built, name)).toMatchObject({
        OverrideAction: { None: {} },
        Statement: {
          ManagedRuleGroupStatement: { VendorName: "AWS", Name: name },
        },
      });
    }
    expect(rule(built, "AWSManagedRulesAnonymousIpList")).toMatchObject({
      OverrideAction: { Count: {} },
    });
  });

  it("limits each token, by the header it is given, and each address, with a 429", () => {
    const built = build().template();
    const tooMany = {
      Block: {
        CustomResponse: {
          ResponseCode: 429,
          CustomResponseBodyKey: "too-many-requests",
        },
      },
    };

    expect(rule(built, "RateLimitPerToken")).toMatchObject({
      Action: tooMany,
      Statement: {
        RateBasedStatement: {
          Limit: 100,
          EvaluationWindowSec: 300,
          AggregateKeyType: "CUSTOM_KEYS",
          CustomKeys: [
            {
              Header: {
                Name: "x-example-token",
                TextTransformations: [{ Priority: 0, Type: "NONE" }],
              },
            },
          ],
        },
      },
    });
    expect(rule(built, "RateLimitPerIp")).toMatchObject({
      Action: tooMany,
      Statement: {
        RateBasedStatement: {
          Limit: 500,
          EvaluationWindowSec: 300,
          AggregateKeyType: "IP",
        },
      },
    });
  });

  it("logs every evaluated request to a retained log group, with the headers it is given redacted", () => {
    const built = build().template();

    built.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
      Properties: {
        LogGroupName: "aws-waf-logs-example-web-acl",
        RetentionInDays: 365,
      },
    });
    built.hasResourceProperties("AWS::WAFv2::LoggingConfiguration", {
      ResourceArn: { "Fn::GetAtt": [Match.stringLikeRegexp("WebAcl"), "Arn"] },
      RedactedFields: [
        { SingleHeader: { Name: "x-example-token" } },
        { SingleHeader: { Name: "cookie" } },
      ],
    });
    built.hasResourceProperties("AWS::WAFv2::WebACL", {
      DataProtectionConfig: {
        DataProtections: [
          Match.objectLike({
            Action: "SUBSTITUTION",
            Field: {
              FieldType: "SINGLE_HEADER",
              FieldKeys: ["x-example-token"],
            },
          }),
          Match.objectLike({
            Action: "SUBSTITUTION",
            Field: { FieldType: "SINGLE_HEADER", FieldKeys: ["cookie"] },
          }),
        ],
      },
    });
  });
});
