import { readFileSync } from "node:fs";
import path from "node:path";

import { buildOriginRequestFunction } from "@repo/frontdoor-origin-request";
import type { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ISSUERS, stackIn } from "../test/helpers.ts";
import { OriginRequestFunction } from "./origin-request-function.ts";

function build(region = "us-east-1") {
  const stack = stackIn(region);
  const originRequest = new OriginRequestFunction(stack, "OriginRequest", {
    environment: "sandbox",
    issuers: ISSUERS,
  });
  return {
    app: stack.node.root as App,
    originRequest,
    template: Template.fromStack(stack),
  };
}

describe("OriginRequestFunction", () => {
  it("refuses any region but us-east-1", () => {
    expect(() => build("eu-west-2")).toThrow("us-east-1");
  });

  it("runs on Node.js 24 on x86-64, with 1,024 MB and 10 seconds, and is retained", () => {
    const { template } = build();

    template.hasResource("AWS::Lambda::Function", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        FunctionName: "frontdoor-sandbox-origin-request",
        Runtime: "nodejs24.x",
        Architectures: ["x86_64"],
        Handler: "index.handler",
        MemorySize: 1024,
        Timeout: 10,
        Role: { "Fn::GetAtt": [Match.stringLikeRegexp("Role"), "Arn"] },
        LoggingConfig: { LogGroup: "/flex/frontdoor/sandbox/origin-request" },
      },
    });
    template.hasResource("AWS::Lambda::Version", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  // Lambda@Edge refuses a function with environment variables, a VPC, layers or tracing.
  it("sets nothing Lambda@Edge refuses", () => {
    const { template } = build();
    const [resource] = Object.values(
      template.findResources("AWS::Lambda::Function"),
    );

    expect(Object.keys(resource?.Properties as object).sort()).toEqual([
      "Architectures",
      "Code",
      "FunctionName",
      "Handler",
      "LoggingConfig",
      "MemorySize",
      "Role",
      "Runtime",
      "Timeout",
    ]);
  });

  it("creates no log group, so none exists where the function doesn't write", () => {
    build().template.resourceCountIs("AWS::Logs::LogGroup", 0);
  });

  it("deploys the bundle built with the environment's issuers", () => {
    const { app, template } = build();
    const [resource] = Object.values(
      template.findResources("AWS::Lambda::Function"),
    );
    // CDK stages the asset in the app's output directory, named by the hash its key carries.
    const key = (resource?.Properties as { Code: { S3Key: string } }).Code
      .S3Key;
    const code = readFileSync(
      path.join(app.outdir, `asset.${key.replace(/\.zip$/, "")}`, "index.js"),
      "utf8",
    );

    expect(code).toBe(buildOriginRequestFunction({ issuers: ISSUERS }));
  });

  it("has a role of its own that Lambda@Edge can assume, with only the log stack's policy", () => {
    const { template } = build();

    template.resourceCountIs("AWS::IAM::Role", 1);
    template.resourceCountIs("AWS::IAM::Policy", 0);
    template.resourceCountIs("AWS::IAM::ManagedPolicy", 0);
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "frontdoor-sandbox-edge",
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: {
              Service: ["edgelambda.amazonaws.com", "lambda.amazonaws.com"],
            },
          },
        ],
      },
      ManagedPolicyArns: [
        Match.stringLikeRegexp(
          "^arn:[a-z-]+:iam::123456789012:policy/frontdoor-sandbox-origin-request-logs-eu-west-2$",
        ),
      ],
    });
    const [role] = Object.values(template.findResources("AWS::IAM::Role"));
    expect(role?.Properties).not.toHaveProperty("Policies");
    expect(JSON.stringify(template.toJSON())).not.toContain(
      "logs:CreateLogGroup",
    );
  });
});
