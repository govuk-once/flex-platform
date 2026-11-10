import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ACCOUNT, stack } from "../test/helpers.ts";
import { GatewaySecret } from "./gateway-secret.ts";

const READER = `arn:aws:iam::${ACCOUNT}:role/gateway-sandbox-dvla-execution`;

function build(nag = false) {
  const scope = stack(nag);
  new GatewaySecret(scope, "Upstream", {
    secretName: "gateway-sandbox-dvla",
    readerArn: READER,
    endpointId: "vpce-0secretsmanager",
  });
  return { scope, template: Template.fromStack(scope) };
}

describe("GatewaySecret", () => {
  it("is created without a value, for a person to put, and kept when its stack goes", () => {
    const { template } = build();
    const [secret] = Object.values(
      template.findResources("AWS::SecretsManager::Secret"),
    ) as { Properties: Record<string, unknown>; DeletionPolicy: string }[];

    expect(secret?.Properties).toEqual({
      Name: "gateway-sandbox-dvla",
      Description: "The gateway's credentials, which a person puts",
    });
    expect(secret?.DeletionPolicy).toBe("Retain");
  });

  it("can be read by its gateway's role alone, through the endpoint alone", () => {
    build().template.hasResourceProperties(
      "AWS::SecretsManager::ResourcePolicy",
      {
        ResourcePolicy: {
          Statement: [
            {
              Effect: "Deny",
              Principal: { AWS: "*" },
              Action: "secretsmanager:GetSecretValue",
              Resource: "*",
              Condition: { StringNotEquals: { "aws:PrincipalArn": READER } },
            },
            {
              Effect: "Deny",
              Principal: { AWS: "*" },
              Action: "secretsmanager:GetSecretValue",
              Resource: "*",
              Condition: {
                StringNotEquals: { "aws:SourceVpce": "vpce-0secretsmanager" },
              },
            },
          ],
        },
      },
    );
  });

  it("has no unacknowledged cdk-nag finding", () => {
    expect(() => build(true)).not.toThrow();
  });
});
