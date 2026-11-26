import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { stackIn } from "../test/helpers.ts";
import { PushIdSecret } from "./push-id-secret.ts";

function build(region = "eu-west-2", nag = false) {
  const stack = stackIn(region, nag);
  new PushIdSecret(stack, "PushIdSecret", { environment: "sandbox" });
  return { stack };
}

describe("PushIdSecret", () => {
  it("refuses any region but the one the edge reads it in", () => {
    expect(() => Template.fromStack(build("us-east-1").stack)).toThrow(
      "eu-west-2",
    );
  });

  it("is created empty, for a person to put its value, and retained", () => {
    const { stack } = build();
    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::SecretsManager::Secret", 1);
    const [secret] = Object.values(
      template.findResources("AWS::SecretsManager::Secret"),
    );
    expect(secret).toMatchObject({
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: { Name: "frontdoor-sandbox-push-id-secret" },
    });
    // Neither a value a deploy made, nor one a template holds.
    expect(Object.keys(secret?.Properties as object).sort()).toEqual([
      "Description",
      "Name",
    ]);
  });

  it("lets nothing but the edge's role read it, whatever else allows it", () => {
    const { stack } = build();
    const template = Template.fromStack(stack);

    template.hasResourceProperties("AWS::SecretsManager::ResourcePolicy", {
      ResourcePolicy: {
        Statement: [
          {
            Effect: "Deny",
            Principal: { AWS: "*" },
            Action: "secretsmanager:GetSecretValue",
            Resource: "*",
            Condition: {
              StringNotEquals: {
                "aws:PrincipalArn":
                  "arn:aws:iam::123456789012:role/frontdoor-sandbox-edge",
              },
            },
          },
        ],
      },
    });
  });

  it("has no unacknowledged cdk-nag finding", () => {
    expect(() =>
      Template.fromStack(build("eu-west-2", true).stack),
    ).not.toThrow();
  });
});
