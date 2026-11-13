import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { assert, describe, expect, it } from "vitest";

import { stackIn } from "../test/helpers.ts";
import { MIN_PASSWORD_LENGTH, TestUserPool } from "./test-user-pool.ts";

function build(nag = false) {
  const stack = stackIn("eu-west-2", nag);
  new TestUserPool(stack, "TestUsers");
  const app = stack.node.root;
  assert.instanceOf(app, App);
  return { app, template: Template.fromStack(stack) };
}

describe("TestUserPool", () => {
  it("has no unacknowledged cdk-nag finding", () => {
    expect(() => build(true).app.synth()).not.toThrow();
  });

  it("is a pool and its client, and nothing else", () => {
    const resources = Object.values(
      build().template.toJSON().Resources as Record<string, { Type: string }>,
    ).map(({ Type }) => Type);

    expect(resources.toSorted()).toEqual([
      "AWS::Cognito::UserPool",
      "AWS::Cognito::UserPoolClient",
    ]);
  });

  // Cognito generates the IDs the Frontdoor's config names, so the pool must never be replaced.
  it("is retained, and protected from deletion", () => {
    const { template } = build();

    template.hasResource("AWS::Cognito::UserPool", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({
        UserPoolName: "shared-test-users",
        DeletionProtection: "ACTIVE",
      }),
    });
  });

  it("lets only an administrator create a user, and recovers no account", () => {
    build().template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      AccountRecoverySetting: {
        RecoveryMechanisms: [{ Name: "admin_only", Priority: 1 }],
      },
      MfaConfiguration: "OFF",
      UserPoolTier: "LITE",
    });
  });

  it("accepts only a long password, as a generated one is", () => {
    build().template.hasResourceProperties("AWS::Cognito::UserPool", {
      Policies: {
        PasswordPolicy: Match.objectLike({
          MinimumLength: MIN_PASSWORD_LENGTH,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        }),
      },
    });
  });

  it("signs in with a password through the public API, and through nothing else", () => {
    build().template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      ClientName: "shared-test-users",
      ExplicitAuthFlows: Match.exact([
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH",
      ]),
      GenerateSecret: false,
      PreventUserExistenceErrors: "ENABLED",
      AllowedOAuthFlows: Match.absent(),
      CallbackURLs: Match.absent(),
    });
  });
});
