import { TABLE_MANAGEMENT_ACTIONS } from "@repo/infra-constructs";
import { sortedNames } from "@repo/utils/sorted-names";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { stackIn } from "../test/helpers.ts";
import { KeyRotation, type KeyRotationProps } from "./key-rotation.ts";

const ACCOUNT = "123456789012";

const EDGE_ROLE = `arn:aws:iam::${ACCOUNT}:role/frontdoor-sandbox-edge`;
const ROTATION_ROLE = `arn:aws:iam::${ACCOUNT}:role/frontdoor-sandbox-caller-token-key-rotation`;
// Every gateway's role, by pattern, in two other accounts.
const GATEWAY_ROLES = [
  "arn:aws:iam::100000000003:role/gateway-sandbox-*",
  "arn:aws:iam::100000000004:role/gateway-sandbox-*",
];

const PROPS: KeyRotationProps = {
  environment: "sandbox",
  kind: "caller-token",
  keyAlias: "alias/frontdoor-sandbox-caller-token",
  privateKeyReaderRoleArns: [EDGE_ROLE],
  publicKeyReaderRoleArns: GATEWAY_ROLES,
};

function build(region = "eu-west-2", nag = false, props = PROPS) {
  const stack = stackIn(region, nag);
  new KeyRotation(stack, "KeyRotation", props);
  return { stack };
}

const root = (account: string) => `arn:aws:iam::${account}:root`;

function expectedPolicy(table: string, readers: string[], accounts: string[]) {
  const Resource = `arn:aws:dynamodb:eu-west-2:${ACCOUNT}:table/${table}`;
  const deny = (
    Sid: string,
    NotAction: string | string[],
    Condition: object,
  ) => ({
    Sid,
    Effect: "Deny",
    Principal: { AWS: "*" },
    NotAction,
    Resource,
    Condition,
  });
  const principals = accounts.map(root);
  return {
    PolicyDocument: {
      Statement: [
        {
          Sid: "AllowItsReadersToScan",
          Effect: "Allow",
          Principal: {
            AWS: principals.length === 1 ? principals[0] : principals,
          },
          Action: "dynamodb:Scan",
          Resource,
          Condition: { ArnLike: { "aws:PrincipalArn": readers } },
        },
        deny(
          "DenyOthersAllButManagingTheTable",
          [...TABLE_MANAGEMENT_ACTIONS],
          {
            ArnNotLike: {
              "aws:PrincipalArn": sortedNames([ROTATION_ROLE, ...readers]),
            },
          },
        ),
        deny(
          "DenyKeyRotationAllButItsWork",
          ["dynamodb:DeleteItem", "dynamodb:PutItem", "dynamodb:Scan"],
          { ArnLike: { "aws:PrincipalArn": [ROTATION_ROLE] } },
        ),
        deny("DenyReadersAllButItsWork", "dynamodb:Scan", {
          ArnLike: { "aws:PrincipalArn": readers },
        }),
      ],
      Version: "2012-10-17",
    },
  };
}

describe("KeyRotation", () => {
  it("runs one copy at a time, every 15 minutes, logging to its own group", () => {
    const { stack } = build();
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "frontdoor-sandbox-caller-token-key-rotation",
      Runtime: "nodejs24.x",
      Handler: "index.handler",
      ReservedConcurrentExecutions: 1,
      LoggingConfig: {
        LogGroup: { Ref: Match.stringLikeRegexp("^KeyRotationLogs") },
      },
    });
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      Name: "frontdoor-sandbox-caller-token-key-rotation",
      Description: "Runs the caller token key rotation",
      ScheduleExpression: "rate(15 minutes)",
      FlexibleTimeWindow: { Mode: "OFF" },
      State: "ENABLED",
      Target: {
        Arn: {
          "Fn::GetAtt": [Match.stringLikeRegexp("^KeyRotationFunction"), "Arn"],
        },
        RoleArn: {
          "Fn::GetAtt": [
            Match.stringLikeRegexp("^KeyRotationSchedulerRole"),
            "Arn",
          ],
        },
        RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 },
      },
    });
    template.resourceCountIs("AWS::Events::Rule", 0);
    template.resourceCountIs("AWS::Lambda::Permission", 0);
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/flex/frontdoor/sandbox/caller-token-key-rotation",
    });
  });

  it("alarms on runs that fail in two of three periods, with no action", () => {
    Template.fromStack(build().stack).hasResourceProperties(
      "AWS::CloudWatch::Alarm",
      {
        AlarmName: "frontdoor-sandbox-caller-token-key-rotation-failed",
        AlarmDescription: Match.stringLikeRegexp(
          "^The caller token key rotation in sandbox failed .* See the caller token page ",
        ),
        Namespace: "AWS/Lambda",
        MetricName: "Errors",
        Dimensions: [
          {
            Name: "FunctionName",
            Value: { Ref: Match.stringLikeRegexp("^KeyRotationFunction") },
          },
        ],
        Statistic: "Sum",
        Period: 900,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 3,
        DatapointsToAlarm: 2,
        TreatMissingData: "notBreaching",
        AlarmActions: Match.absent(),
      },
    );
  });

  it("makes key pairs only under the signing key, by alias, for the caller token's purpose", () => {
    Template.fromStack(build().stack).hasResourceProperties("AWS::IAM::Role", {
      RoleName: "frontdoor-sandbox-caller-token-key-rotation",
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Effect: "Allow",
                Action: "kms:GenerateDataKeyPairWithoutPlaintext",
                Resource: `arn:aws:kms:eu-west-2:${ACCOUNT}:key/*`,
                Condition: {
                  "ForAnyValue:StringEquals": {
                    "kms:ResourceAliases":
                      "alias/frontdoor-sandbox-caller-token",
                  },
                  StringEquals: {
                    "kms:EncryptionContext:purpose": "flex-caller-token",
                  },
                },
              },
            ]),
          },
        },
      ],
    });
  });

  it("checks a key decrypts only by encrypting it again under the same key, and can't decrypt", () => {
    const { stack } = build();
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "frontdoor-sandbox-caller-token-key-rotation",
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Effect: "Allow",
                Action: ["kms:ReEncryptFrom", "kms:ReEncryptTo"],
                Resource: `arn:aws:kms:eu-west-2:${ACCOUNT}:key/*`,
                Condition: {
                  "ForAnyValue:StringEquals": {
                    "kms:ResourceAliases":
                      "alias/frontdoor-sandbox-caller-token",
                  },
                  StringEquals: {
                    "kms:EncryptionContext:purpose": "flex-caller-token",
                  },
                  Bool: { "kms:ReEncryptOnSameKey": "true" },
                },
              },
            ]),
          },
        },
      ],
    });
    expect(
      JSON.stringify(template.findResources("AWS::IAM::Role")),
    ).not.toContain("kms:Decrypt");
  });

  it("keeps the kind's keys in two tables, which only it may change, and only it and each table's readers read", () => {
    const { stack } = build();
    const template = Template.fromStack(stack);
    for (const [name, readers, accounts] of [
      ["frontdoor-sandbox-caller-token-private-keys", [EDGE_ROLE], [ACCOUNT]],
      [
        "frontdoor-sandbox-caller-token-public-keys",
        GATEWAY_ROLES,
        ["100000000003", "100000000004"],
      ],
    ] as const) {
      template.hasResource("AWS::DynamoDB::Table", {
        Properties: Match.exact({
          TableName: name,
          KeySchema: [{ AttributeName: "keyId", KeyType: "HASH" }],
          AttributeDefinitions: [
            { AttributeName: "keyId", AttributeType: "S" },
          ],
          BillingMode: "PAY_PER_REQUEST",
          PointInTimeRecoverySpecification: {
            PointInTimeRecoveryEnabled: true,
          },
          DeletionProtectionEnabled: true,
          ResourcePolicy: expectedPolicy(name, [...readers], [...accounts]),
        }),
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
      });
    }
    template.resourceCountIs("AWS::DynamoDB::Table", 2);
  });

  it("reads and changes only its tables", () => {
    Template.fromStack(build().stack).hasResourceProperties("AWS::IAM::Role", {
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Effect: "Allow",
                Action: [
                  "dynamodb:DeleteItem",
                  "dynamodb:PutItem",
                  "dynamodb:Scan",
                ],
                Resource: [
                  `arn:aws:dynamodb:eu-west-2:${ACCOUNT}:table/frontdoor-sandbox-caller-token-private-keys`,
                  `arn:aws:dynamodb:eu-west-2:${ACCOUNT}:table/frontdoor-sandbox-caller-token-public-keys`,
                ],
              },
            ]),
          },
        },
      ],
    });
  });

  it("is run by a schedule whose role may only invoke the function, assumed only through the account's default schedule group", () => {
    Template.fromStack(build().stack).hasResourceProperties("AWS::IAM::Role", {
      RoleName: "frontdoor-sandbox-caller-token-key-rotation-schedule",
      AssumeRolePolicyDocument: Match.exact({
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: { Service: "scheduler.amazonaws.com" },
            Condition: {
              StringEquals: {
                "aws:SourceAccount": ACCOUNT,
                "aws:SourceArn": `arn:aws:scheduler:eu-west-2:${ACCOUNT}:schedule-group/default`,
              },
            },
          },
        ],
        Version: "2012-10-17",
      }),
      Policies: Match.exact([
        {
          PolicyName: "InvokeKeyRotation",
          PolicyDocument: {
            Statement: [
              {
                Action: "lambda:InvokeFunction",
                Effect: "Allow",
                Resource: {
                  "Fn::GetAtt": [
                    Match.stringLikeRegexp("^KeyRotationFunction"),
                    "Arn",
                  ],
                },
              },
            ],
            Version: "2012-10-17",
          },
        },
      ]),
    });
  });

  it("admits no reader to a table that has none", () => {
    const { stack } = build("eu-west-2", false, {
      ...PROPS,
      publicKeyReaderRoleArns: [],
    });
    const template = Template.fromStack(stack);
    const policy = JSON.stringify(
      template.findResources("AWS::DynamoDB::Table"),
    );
    expect(policy.match(/AllowItsReadersToScan/g)).toHaveLength(1);
  });

  it("refuses a reader whose ARN names no account", () => {
    expect(() =>
      Template.fromStack(
        build("eu-west-2", false, {
          ...PROPS,
          publicKeyReaderRoleArns: ["arn:aws:iam::gateways:role/gateway-*"],
        }).stack,
      ),
    ).toThrow(
      "The role ARN arn:aws:iam::gateways:role/gateway-* names no account",
    );
  });

  it("is built in the signing region alone", () => {
    expect(() => Template.fromStack(build("us-east-1").stack)).toThrow(
      "Key rotation runs in eu-west-2, beside the signing key, not us-east-1",
    );
  });

  it("has no unacknowledged cdk-nag finding", () => {
    expect(() =>
      Template.fromStack(build("eu-west-2", true).stack),
    ).not.toThrow();
  });
});
