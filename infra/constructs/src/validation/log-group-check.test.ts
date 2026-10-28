import { RemovalPolicy, Stack, Validations } from "aws-cdk-lib";
import { Key } from "aws-cdk-lib/aws-kms";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { describe, expect, it } from "vitest";

import { cdkApp } from "../cdk-app.ts";
import { PlatformLogGroup } from "../log-group.ts";
import { LOG_GROUP_RULE, LogGroupCheck } from "./log-group-check.ts";

function checkedStack() {
  const app = cdkApp();
  Validations.of(app).addPlugins(new LogGroupCheck());
  const stack = new Stack(app, "Test", {
    env: { account: "123456789012", region: "eu-west-2" },
  });
  return { app, stack };
}

describe("LogGroupCheck", () => {
  it("passes a PlatformLogGroup", () => {
    const { app, stack } = checkedStack();
    new PlatformLogGroup(stack, "Logs");

    expect(() => app.synth()).not.toThrow();
  });

  it("fails synth on a log group with CDK's defaults", () => {
    const { app, stack } = checkedStack();
    new LogGroup(stack, "Logs");

    expect(() => app.synth()).toThrow(LOG_GROUP_RULE);
  });

  it("fails synth on a log group kept a year but deleted with its stack", () => {
    const { app, stack } = checkedStack();
    new LogGroup(stack, "Logs", {
      retention: RetentionDays.ONE_YEAR,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    expect(() => app.synth()).toThrow(LOG_GROUP_RULE);
  });

  it("fails synth on a log group kept a year and retained, but with no KMS key", () => {
    const { app, stack } = checkedStack();
    new LogGroup(stack, "Logs", {
      retention: RetentionDays.ONE_YEAR,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    expect(() => app.synth()).toThrow(LOG_GROUP_RULE);
  });

  it("fails synth on a log group kept a year, retained and encrypted, but not protected from deletion", () => {
    const { app, stack } = checkedStack();
    new LogGroup(stack, "Logs", {
      retention: RetentionDays.ONE_YEAR,
      removalPolicy: RemovalPolicy.RETAIN,
      encryptionKey: new Key(stack, "Key"),
    });

    expect(() => app.synth()).toThrow(LOG_GROUP_RULE);
  });

  it("fails synth on a retained log group kept for another period", () => {
    const { app, stack } = checkedStack();
    new LogGroup(stack, "Logs", {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    expect(() => app.synth()).toThrow(LOG_GROUP_RULE);
  });
});
