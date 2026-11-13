import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { stackIn } from "../../test/cloudfront.ts";
import {
  cloudFrontFunctionLogGroupName,
  PlatformCloudFrontFunction,
} from "./function.ts";

const CODE = "function handler(event) { return event.request; }";

function build(region = "us-east-1", checks = false) {
  const { app, stack } = stackIn(region, checks);
  new PlatformCloudFrontFunction(stack, "ViewerRequest", {
    functionName: "example-viewer-request",
    code: CODE,
  });
  return { app, stack };
}

function template(): Template {
  return Template.fromStack(build().stack);
}

describe("cloudFrontFunctionLogGroupName", () => {
  it("is the name CloudFront writes a function's logs to", () => {
    expect(cloudFrontFunctionLogGroupName("example-viewer-request")).toBe(
      "/aws/cloudfront/function/example-viewer-request",
    );
  });
});

describe("PlatformCloudFrontFunction", () => {
  it("refuses any region but us-east-1", () => {
    expect(() => build("eu-west-2")).toThrow("us-east-1");
  });

  it("passes cdk-nag and the platform's log group check", () => {
    expect(() => build("us-east-1", true).app.synth()).not.toThrow();
  });

  it("holds the code it is given, under the name it is given, for cloudfront-js-2.0", () => {
    template().hasResourceProperties("AWS::CloudFront::Function", {
      Name: "example-viewer-request",
      AutoPublish: true,
      FunctionConfig: { Runtime: "cloudfront-js-2.0" },
      FunctionCode: CODE,
    });
  });

  // CloudFront would create the group itself, with no retention, if the function ran first.
  it("creates the log group CloudFront writes it to before the function exists", () => {
    const built = template();

    built.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
      Properties: {
        LogGroupName: "/aws/cloudfront/function/example-viewer-request",
        RetentionInDays: 365,
      },
    });
    const [logGroupId] = Object.keys(
      built.findResources("AWS::Logs::LogGroup"),
    );
    built.hasResource("AWS::CloudFront::Function", {
      DependsOn: Match.arrayWith([logGroupId]),
    });
  });

  it("lets CloudFront's logger use the log group's key, for that log group alone", () => {
    template().hasResourceProperties("AWS::KMS::Key", {
      KeyPolicy: {
        Statement: Match.arrayWith([
          {
            Sid: "AllowCloudFrontFunctionLogs",
            Effect: "Allow",
            Principal: { AWS: "*" },
            Action: ["kms:Encrypt", "kms:GenerateDataKey*"],
            Resource: "*",
            Condition: {
              StringEquals: {
                "kms:CallerAccount": "123456789012",
                "kms:ViaService": "logs.us-east-1.amazonaws.com",
              },
              ArnEquals: {
                "aws:PrincipalArn":
                  "arn:aws:iam::123456789012:role/aws-service-role/logger.cloudfront.amazonaws.com/AWSServiceRoleForCloudFrontLogger",
                "kms:EncryptionContext:aws:logs:arn":
                  "arn:aws:logs:us-east-1:123456789012:log-group:/aws/cloudfront/function/example-viewer-request",
              },
            },
          },
        ]),
      },
    });
  });
});
