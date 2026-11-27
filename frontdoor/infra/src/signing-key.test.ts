import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { stackIn } from "../test/helpers.ts";
import { SigningKey, type SigningKeyProps } from "./signing-key.ts";

const ACCOUNT = "123456789012";
const EDGE_ROLE = `arn:aws:iam::${ACCOUNT}:role/frontdoor-sandbox-edge`;
const ROTATION_ROLE = `arn:aws:iam::${ACCOUNT}:role/frontdoor-sandbox-caller-token-key-rotation`;

const PROPS: SigningKeyProps = {
  environment: "sandbox",
  decryptRoleArns: [EDGE_ROLE],
  rotationRoleArn: ROTATION_ROLE,
};

function build(nag = false, props = PROPS) {
  const stack = stackIn("eu-west-2", nag);
  new SigningKey(stack, "SigningKey", props);
  return { stack };
}

const deny = (Sid: string, Action: string | string[], Condition?: object) => ({
  Sid,
  Effect: "Deny",
  Principal: { AWS: "*" },
  Action,
  Resource: "*",
  ...(Condition !== undefined && { Condition }),
});

// CDK's default: managing the key, and using it, is left to IAM.
const ACCOUNT_STATEMENT = {
  Effect: "Allow",
  Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` },
  Action: "kms:*",
  Resource: "*",
};

describe("SigningKey", () => {
  it("is a symmetric key, rotated, retained, and found by the alias every region shares", () => {
    const { stack } = build();
    const template = Template.fromStack(stack);
    template.hasResource("AWS::KMS::Key", {
      Properties: Match.exact({
        Description:
          "Wraps the private keys the edge signs the caller token with",
        EnableKeyRotation: true,
        KeyPolicy: Match.anyValue(),
      }),
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
    template.hasResourceProperties("AWS::KMS::Alias", {
      AliasName: "alias/frontdoor-sandbox-caller-token",
    });
    // Its logical ID, which a deployed key is known by: another would replace the key.
    expect(Object.keys(template.findResources("AWS::KMS::Key"))).toEqual([
      "SigningKey49B95470",
    ]);
  });

  it("denies decrypting to all but its readers, encrypting to all but key rotation, and encrypting again under another key to anyone", () => {
    Template.fromStack(build().stack).hasResourceProperties("AWS::KMS::Key", {
      KeyPolicy: {
        Statement: [
          ACCOUNT_STATEMENT,
          deny("DenyDecryptToAllButItsReaders", "kms:Decrypt", {
            ArnNotLike: { "aws:PrincipalArn": [EDGE_ROLE] },
          }),
          deny(
            "DenyEncryptingToAllButKeyRotation",
            ["kms:Encrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*"],
            { ArnNotLike: { "aws:PrincipalArn": [ROTATION_ROLE] } },
          ),
          deny(
            "DenyKeyRotationAllButItsWork",
            [
              "kms:Encrypt",
              "kms:GenerateDataKey",
              "kms:GenerateDataKeyPair",
              "kms:GenerateDataKeyWithoutPlaintext",
            ],
            { ArnLike: { "aws:PrincipalArn": [ROTATION_ROLE] } },
          ),
          deny("DenyReEncryptOntoAnotherKey", "kms:ReEncrypt*", {
            BoolIfExists: { "kms:ReEncryptOnSameKey": "false" },
          }),
        ],
        Version: "2012-10-17",
      },
    });
  });

  // So the policy names no role a deploy runs as, and can always be rewritten.
  it("denies nothing that manages the key", () => {
    const template = Template.fromStack(build().stack);
    const policy = JSON.stringify(template.findResources("AWS::KMS::Key"));
    // Every action the policy names, and no condition key.
    const denied = [...policy.matchAll(/"kms:([A-Za-z*]+)"(?!:)/g)]
      .map(([, action]) => action)
      .filter((action) => action !== "*");
    expect(new Set(denied)).toEqual(
      new Set([
        "Decrypt",
        "Encrypt",
        "GenerateDataKey*",
        "GenerateDataKey",
        "GenerateDataKeyPair",
        "GenerateDataKeyWithoutPlaintext",
        "ReEncrypt*",
      ]),
    );
    expect(policy).not.toContain("NotAction");
  });

  it("names each role that decrypts once, in order", () => {
    const other = `arn:aws:iam::${ACCOUNT}:role/frontdoor-sandbox-another`;
    const { stack } = build(false, {
      ...PROPS,
      decryptRoleArns: [EDGE_ROLE, other, EDGE_ROLE],
    });
    Template.fromStack(stack).hasResourceProperties("AWS::KMS::Key", {
      KeyPolicy: {
        Statement: Match.arrayWith([
          deny("DenyDecryptToAllButItsReaders", "kms:Decrypt", {
            ArnNotLike: { "aws:PrincipalArn": [other, EDGE_ROLE] },
          }),
        ]),
      },
    });
  });

  it("denies decrypting to everyone when no role decrypts", () => {
    const { stack } = build(false, { ...PROPS, decryptRoleArns: [] });
    Template.fromStack(stack).hasResourceProperties("AWS::KMS::Key", {
      KeyPolicy: {
        Statement: Match.arrayWith([
          deny("DenyDecryptToAllButItsReaders", "kms:Decrypt"),
        ]),
      },
    });
  });

  it("refuses a role named by a pattern, which would let every role it matches use the key", () => {
    const pattern = `arn:aws:iam::${ACCOUNT}:role/frontdoor-sandbox-*`;
    expect(() =>
      build(false, { ...PROPS, decryptRoleArns: [pattern] }),
    ).toThrow(
      `The role that decrypts is named exactly, not by a pattern: ${pattern}`,
    );
    expect(() => build(false, { ...PROPS, rotationRoleArn: pattern })).toThrow(
      `The role that rotates the keys is named exactly, not by a pattern: ${pattern}`,
    );
  });

  it("has no unacknowledged cdk-nag finding", () => {
    expect(() => Template.fromStack(build(true).stack)).not.toThrow();
  });
});
