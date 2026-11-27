import { SIGNING_KEY_REGION } from "@repo/frontdoor-shared";
import { cdkApp, NETWORK_REGION } from "@repo/infra-constructs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../../test/helpers.ts";
import {
  callerTokenPublicKeysTableArn,
  FrontdoorCallerTokenKeysStack,
  frontdoorCallerTokenKeysStackName,
} from "./frontdoor-keys.ts";

const PROD = FIXTURE_STAGES[2];
const [DEV] = PROD.environments;
const ROTATION_ROLE = `arn:aws:iam::${DEV.frontdoor.account}:role/frontdoor-${DEV.name}-caller-token-key-rotation`;
const EDGE_ROLE = `arn:aws:iam::${DEV.frontdoor.account}:role/frontdoor-${DEV.name}-edge`;

describe("FrontdoorCallerTokenKeysStack", () => {
  it("is one per environment, in the frontdoor account in eu-west-2, protected from deletion", () => {
    const assembly = synthesizedStage(PROD);

    for (const environment of PROD.environments) {
      const stack = assembly.getStackByName(
        frontdoorCallerTokenKeysStackName(environment),
      );
      expect(stack.environment).toMatchObject({
        account: environment.frontdoor.account,
        region: "eu-west-2",
      });
      expect(stack.terminationProtection).toBe(true);
    }
  });

  it("lets every gateway's role in every domain account scan the public keys, by its name's pattern, and read them no other way", () => {
    const template = Template.fromStack(
      new FrontdoorCallerTokenKeysStack(cdkApp(), DEV),
    );
    const roles = DEV.domainAccounts
      .map(
        ({ account }) =>
          `arn:aws:iam::${account}:role/gateway-${DEV.name}-*-execution`,
      )
      .sort();
    expect(roles.length).toBeGreaterThan(0);

    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: `frontdoor-${DEV.name}-caller-token-public-keys`,
      ResourcePolicy: {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: "AllowItsReadersToScan",
              Effect: "Allow",
              Action: "dynamodb:Scan",
              Condition: { ArnLike: { "aws:PrincipalArn": roles } },
            }),
            Match.objectLike({
              Sid: "DenyOthersAllButManagingTheTable",
              Condition: {
                ArnNotLike: {
                  "aws:PrincipalArn": [ROTATION_ROLE, ...roles].sort(),
                },
              },
            }),
            Match.objectLike({
              Sid: "DenyReadersAllButItsWork",
              NotAction: "dynamodb:Scan",
              Condition: { ArnLike: { "aws:PrincipalArn": roles } },
            }),
          ]),
        },
      },
    });
  });

  it("lets the environment's edge alone decrypt with the signing key, and key rotation alone encrypt with it, by the names their roles are created with", () => {
    const template = Template.fromStack(
      new FrontdoorCallerTokenKeysStack(cdkApp(), DEV),
    );
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: `frontdoor-${DEV.name}-caller-token-key-rotation`,
    });
    template.hasResourceProperties("AWS::KMS::Key", {
      Description:
        "Wraps the private keys the edge signs the caller token with",
      KeyPolicy: {
        Statement: [
          // CDK's default, which leaves managing the key to IAM. Every other statement denies.
          {
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${DEV.frontdoor.account}:root` },
            Action: "kms:*",
            Resource: "*",
          },
          Match.objectLike({
            Sid: "DenyDecryptToAllButItsReaders",
            Effect: "Deny",
            Action: "kms:Decrypt",
            Condition: { ArnNotLike: { "aws:PrincipalArn": [EDGE_ROLE] } },
          }),
          Match.objectLike({
            Sid: "DenyEncryptingToAllButKeyRotation",
            Effect: "Deny",
            Condition: { ArnNotLike: { "aws:PrincipalArn": [ROTATION_ROLE] } },
          }),
          Match.objectLike({
            Sid: "DenyKeyRotationAllButItsWork",
            Effect: "Deny",
            Condition: { ArnLike: { "aws:PrincipalArn": [ROTATION_ROLE] } },
          }),
          Match.objectLike({
            Sid: "DenyReEncryptOntoAnotherKey",
            Effect: "Deny",
            Action: "kms:ReEncrypt*",
          }),
        ],
      },
    });
  });

  it("names the public keys table by ARN, in the region every gateway's network is in", () => {
    expect(SIGNING_KEY_REGION).toBe(NETWORK_REGION);
    expect(callerTokenPublicKeysTableArn(DEV)).toBe(
      `arn:aws:dynamodb:eu-west-2:${DEV.frontdoor.account}:table/frontdoor-${DEV.name}-caller-token-public-keys`,
    );
  });

  it("leaves out a domain account that runs no gateway", () => {
    const [first] = DEV.domainAccounts;
    const idle = { ...first, account: "100000000099", gateways: [] };
    const template = Template.fromStack(
      new FrontdoorCallerTokenKeysStack(cdkApp(), {
        ...DEV,
        domainAccounts: [...DEV.domainAccounts, idle],
      }),
    );
    expect(JSON.stringify(template.toJSON())).not.toContain("100000000099");
  });

  it("holds the secret the environment's edge derives push IDs with, read by that edge's role alone", () => {
    const template = Template.fromStack(
      new FrontdoorCallerTokenKeysStack(cdkApp(), DEV),
    );
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: `frontdoor-${DEV.name}-push-id-secret`,
    });
    template.hasResourceProperties("AWS::SecretsManager::ResourcePolicy", {
      ResourcePolicy: {
        Statement: [
          Match.objectLike({
            Effect: "Deny",
            Condition: {
              StringNotEquals: { "aws:PrincipalArn": EDGE_ROLE },
            },
          }),
        ],
      },
    });
  });

  it("keeps no copy of the public keys outside the tables", () => {
    const template = Template.fromStack(
      new FrontdoorCallerTokenKeysStack(cdkApp(), DEV),
    );
    template.resourceCountIs("AWS::S3::Bucket", 0);
    expect(JSON.stringify(template.toJSON())).not.toContain("s3:");
  });

  it("keeps the caller token's private keys where the environment's edge, and key rotation, alone read them", () => {
    const template = Template.fromStack(
      new FrontdoorCallerTokenKeysStack(cdkApp(), DEV),
    );
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: `frontdoor-${DEV.name}-caller-token-private-keys`,
      ResourcePolicy: {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: "DenyOthersAllButManagingTheTable",
              Condition: {
                ArnNotLike: {
                  "aws:PrincipalArn": [ROTATION_ROLE, EDGE_ROLE],
                },
              },
            }),
          ]),
        },
      },
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: `frontdoor-${DEV.name}-caller-token-public-keys`,
    });
  });
});
