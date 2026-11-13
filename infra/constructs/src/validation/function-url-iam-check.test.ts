import { Stack, Validations } from "aws-cdk-lib";
import {
  CfnUrl,
  Code,
  Function as LambdaFunction,
  FunctionUrlAuthType,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";

import { cdkApp } from "../cdk-app.ts";
import {
  FUNCTION_URL_IAM_RULE,
  FunctionUrlIamCheck,
} from "./function-url-iam-check.ts";

function checkedFunction() {
  const app = cdkApp();
  Validations.of(app).addPlugins(new FunctionUrlIamCheck());
  const stack = new Stack(app, "Test", {
    env: { account: "123456789012", region: "eu-west-2" },
  });
  const fn = new LambdaFunction(stack, "Function", {
    runtime: Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: Code.fromInline("exports.handler = async () => ({});"),
  });
  return { app, stack, fn };
}

describe("FunctionUrlIamCheck", () => {
  it("passes a function with no URL", () => {
    const { app } = checkedFunction();

    expect(() => app.synth()).not.toThrow();
  });

  it("passes a URL with IAM authorisation", () => {
    const { app, fn } = checkedFunction();
    fn.addFunctionUrl({ authType: FunctionUrlAuthType.AWS_IAM });

    expect(() => app.synth()).not.toThrow();
  });

  // Lambda would run the function for anyone who called it.
  it("fails synth on a URL with no authorisation", () => {
    const { app, fn } = checkedFunction();
    fn.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

    expect(() => app.synth()).toThrow(FUNCTION_URL_IAM_RULE);
  });

  it("fails synth on a URL written without an authorisation type it knows", () => {
    const { app, stack, fn } = checkedFunction();
    new CfnUrl(stack, "Url", {
      targetFunctionArn: fn.functionArn,
      authType: "OTHER",
    });

    expect(() => app.synth()).toThrow(FUNCTION_URL_IAM_RULE);
  });
});
