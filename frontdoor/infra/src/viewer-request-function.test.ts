import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ISSUERS, stackIn } from "../test/helpers.ts";
import { ViewerRequestFunction } from "./viewer-request-function.ts";

function template(): Template {
  const stack = stackIn("us-east-1");
  new ViewerRequestFunction(stack, "ViewerRequest", {
    environment: "sandbox",
    issuers: ISSUERS,
  });
  return Template.fromStack(stack);
}

describe("ViewerRequestFunction", () => {
  it("refuses any region but us-east-1", () => {
    expect(
      () =>
        new ViewerRequestFunction(stackIn("eu-west-2"), "ViewerRequest", {
          environment: "sandbox",
          issuers: ISSUERS,
        }),
    ).toThrow("us-east-1");
  });

  it("is built for the cloudfront-js-2.0 runtime with the environment's issuers baked in", () => {
    template().hasResourceProperties("AWS::CloudFront::Function", {
      Name: "frontdoor-sandbox-viewer-request",
      AutoPublish: true,
      FunctionConfig: { Runtime: "cloudfront-js-2.0" },
      FunctionCode: Match.stringLikeRegexp("eu-west-2_example"),
    });
  });

  it("creates the log group CloudFront writes it to before the function exists", () => {
    const built = template();

    built.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
      Properties: {
        LogGroupName:
          "/aws/cloudfront/function/frontdoor-sandbox-viewer-request",
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
                  "arn:aws:logs:us-east-1:123456789012:log-group:/aws/cloudfront/function/frontdoor-sandbox-viewer-request",
              },
            },
          },
        ]),
      },
    });
  });
});
