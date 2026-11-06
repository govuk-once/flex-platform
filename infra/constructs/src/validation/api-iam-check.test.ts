import { Stack, Validations } from "aws-cdk-lib";
import {
  AuthorizationType,
  CfnMethod,
  MockIntegration,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import { describe, expect, it } from "vitest";

import { cdkApp } from "../cdk-app.ts";
import { API_IAM_RULE, ApiIamCheck } from "./api-iam-check.ts";

function checkedStack() {
  const app = cdkApp();
  Validations.of(app).addPlugins(new ApiIamCheck());
  const stack = new Stack(app, "Test", {
    env: { account: "123456789012", region: "eu-west-2" },
  });
  return { app, stack };
}

function api(stack: Stack, authorizationType?: AuthorizationType): RestApi {
  const restApi = new RestApi(
    stack,
    "Api",
    authorizationType === undefined
      ? {}
      : { defaultMethodOptions: { authorizationType } },
  );
  restApi.root.addMethod("GET", new MockIntegration());
  return restApi;
}

describe("ApiIamCheck", () => {
  it("passes a method with IAM authorisation", () => {
    const { app, stack } = checkedStack();
    api(stack, AuthorizationType.IAM);

    expect(() => app.synth()).not.toThrow();
  });

  it("fails synth on a method with CDK's default, no authorisation", () => {
    const { app, stack } = checkedStack();
    api(stack);

    expect(() => app.synth()).toThrow(API_IAM_RULE);
  });

  it("fails synth on a method with an authoriser other than IAM", () => {
    const { app, stack } = checkedStack();
    const restApi = api(stack, AuthorizationType.IAM);
    new CfnMethod(stack, "Cognito", {
      restApiId: restApi.restApiId,
      resourceId: restApi.root.resourceId,
      httpMethod: "POST",
      authorizationType: AuthorizationType.COGNITO,
      authorizerId: "authorizer",
    });

    expect(() => app.synth()).toThrow(API_IAM_RULE);
  });
});
