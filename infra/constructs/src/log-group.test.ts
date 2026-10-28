import { type App, Stack, Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";

import { cdkApp } from "./cdk-app.ts";
import { PlatformLogGroup } from "./log-group.ts";

function build(name?: string, nag = false): { app: App; template: Template } {
  const app = cdkApp();
  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const stack = new Stack(app, "Test", {
    env: { account: "123456789012", region: "eu-west-2" },
  });
  new PlatformLogGroup(
    stack,
    "Logs",
    name === undefined ? {} : { logGroupName: name },
  );
  return { app, template: Template.fromStack(stack) };
}

describe("PlatformLogGroup", () => {
  it("has no unacknowledged cdk-nag finding", () => {
    const { app } = build(undefined, true);

    expect(() => app.synth()).not.toThrow();
  });

  it("keeps logs for a year, refuses to be deleted and outlives its stack", () => {
    const { template } = build();

    template.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: { RetentionInDays: 365, DeletionProtectionEnabled: true },
    });
  });

  it("encrypts every log group in a stack with one retained, rotated key", () => {
    const app = cdkApp();
    const stack = new Stack(app, "Test", {
      env: { account: "123456789012", region: "eu-west-2" },
    });
    new PlatformLogGroup(stack, "First");
    new PlatformLogGroup(stack, "Second");
    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::KMS::Key", 1);
    template.hasResource("AWS::KMS::Key", {
      DeletionPolicy: "Retain",
      Properties: { EnableKeyRotation: true },
    });
    const keys = Object.values(
      template.findResources("AWS::Logs::LogGroup"),
    ).map((group) => (group.Properties as { KmsKeyId?: unknown }).KmsKeyId);
    expect(keys).toEqual([
      { "Fn::GetAtt": [expect.stringMatching(/^LogGroupKey/), "Arn"] },
      { "Fn::GetAtt": [expect.stringMatching(/^LogGroupKey/), "Arn"] },
    ]);
  });

  it("lets CloudWatch Logs in the stack's region use the key, for its log groups only", () => {
    const { template } = build();

    template.hasResourceProperties("AWS::KMS::Key", {
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: "logs.eu-west-2.amazonaws.com" },
            Condition: {
              ArnLike: {
                "kms:EncryptionContext:aws:logs:arn": Match.stringLikeRegexp(
                  "^arn:[a-z-]+:logs:eu-west-2:123456789012:log-group:\\*$",
                ),
              },
            },
          }),
        ]),
      },
    });
  });

  it("lets CloudFormation name it unless told otherwise", () => {
    const [unnamed] = Object.values(
      build().template.findResources("AWS::Logs::LogGroup"),
    );
    expect(
      (unnamed?.Properties as { LogGroupName?: string }).LogGroupName,
    ).toBeUndefined();

    build("aws-waf-logs-test").template.hasResourceProperties(
      "AWS::Logs::LogGroup",
      { LogGroupName: "aws-waf-logs-test" },
    );
  });
});
