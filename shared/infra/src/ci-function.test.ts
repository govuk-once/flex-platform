import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ACCOUNT, appOf, stackIn } from "../test/helpers.ts";
import { CI_CONCURRENCY, CiFunction } from "./ci-function.ts";

function build(region = "eu-west-2", nag = false) {
  const stack = stackIn(region, nag);
  const ci = new CiFunction(stack, "Ci");
  return { stack, ci };
}

function template(): Template {
  return Template.fromStack(build().stack);
}

const DISTRIBUTIONS = `arn:aws:cloudfront::${ACCOUNT}:distribution/*`;

describe("CiFunction", () => {
  it("refuses any region but the shared account's", () => {
    expect(() => build("us-east-1")).toThrow("runs in eu-west-2");
  });

  it("passes cdk-nag and the platform's log group check", () => {
    expect(() => appOf(build("eu-west-2", true).stack).synth()).not.toThrow();
  });

  it("is named from the shared account's names, with a short timeout and few copies at once", () => {
    template().hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "shared-ci",
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      Handler: "index.handler",
      Timeout: 10,
      MemorySize: 256,
      ReservedConcurrentExecutions: CI_CONCURRENCY,
    });
  });

  it("logs to a log group of the platform's, by its name", () => {
    const built = template();

    built.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
      Properties: { LogGroupName: "/flex/shared/ci", RetentionInDays: 365 },
    });
    built.hasResourceProperties("AWS::Lambda::Function", {
      LoggingConfig: { LogGroup: { Ref: Match.stringLikeRegexp("^CiLogs") } },
    });
  });

  // No managed policy, which would let it create a log group, and nothing else yet.
  it("runs as a role that may only write to its own log group", () => {
    const built = template();

    built.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "shared-ci",
      ManagedPolicyArns: Match.absent(),
    });
    const [role] = Object.values(built.findResources("AWS::IAM::Role"));
    const statements = (
      role?.Properties as {
        Policies: { PolicyDocument: { Statement: { Action: string[] }[] } }[];
      }
    ).Policies.flatMap(({ PolicyDocument }) => PolicyDocument.Statement);

    expect(statements.flatMap(({ Action }) => Action)).toEqual([
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
    ]);
    built.resourceCountIs("AWS::IAM::Policy", 0);
  });

  // Anything else would have Lambda run the function for whoever found the URL.
  it("has a URL that takes only signed requests", () => {
    template().hasResourceProperties("AWS::Lambda::Url", {
      AuthType: "AWS_IAM",
      TargetFunctionArn: {
        "Fn::GetAtt": [Match.stringLikeRegexp("^CiFunction"), "Arn"],
      },
    });
  });

  // Lambda checks both actions for a call through a URL.
  it("admits CloudFront alone, for this account's distributions, and only through the URL", () => {
    const built = template();

    built.resourceCountIs("AWS::Lambda::Permission", 2);
    built.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunctionUrl",
      Principal: "cloudfront.amazonaws.com",
      FunctionUrlAuthType: "AWS_IAM",
      SourceArn: DISTRIBUTIONS,
    });
    built.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      Principal: "cloudfront.amazonaws.com",
      InvokedViaFunctionUrl: true,
      SourceArn: DISTRIBUTIONS,
    });
  });

  it("gives the URL's host alone, for the distribution to reach it at", () => {
    const { stack, ci } = build();
    const [urlId] = Object.keys(
      Template.fromStack(stack).findResources("AWS::Lambda::Url"),
    );

    expect(stack.resolve(ci.urlHost)).toEqual({
      "Fn::Select": [
        2,
        { "Fn::Split": ["/", { "Fn::GetAtt": [urlId, "FunctionUrl"] }] },
      ],
    });
  });

  // Until the API is built, a request that passes every check at the edge gets an unknown
  // path's answer.
  it("serves nothing yet", () => {
    template().hasResourceProperties("AWS::Lambda::Function", {
      Code: { ZipFile: Match.stringLikeRegexp("statusCode: 404") },
    });
  });
});
