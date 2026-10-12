import { App, Stack, Validations } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";

import { PlatformLogGroup } from "./log-group.ts";

function build(name?: string, nag = false): { app: App; template: Template } {
  const app = new App();
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

  it("keeps logs for a year and outlives its stack", () => {
    const { template } = build();

    template.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: { RetentionInDays: 365 },
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
