import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { stackIn } from "../test/helpers.ts";
import { KeyRotation, type KeyRotationProps } from "./key-rotation.ts";

const ACCOUNT = "123456789012";

const PROPS: KeyRotationProps = {
  environment: "sandbox",
  publicKeysBucket: `frontdoor-sandbox-keys-${ACCOUNT}`,
  publicKeysAccount: ACCOUNT,
  publicKeysRegion: "eu-west-2",
};

function build(region = "eu-west-2", nag = false) {
  const stack = stackIn(region, nag);
  new KeyRotation(stack, "KeyRotation", PROPS);
  return { stack, template: Template.fromStack(stack) };
}

describe("KeyRotation", () => {
  it("runs one copy at a time, every 15 minutes, logging to its own group", () => {
    const { template } = build();
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "frontdoor-sandbox-key-rotation",
      Runtime: "nodejs24.x",
      Handler: "index.handler",
      ReservedConcurrentExecutions: 1,
      LoggingConfig: {
        LogGroup: { Ref: Match.stringLikeRegexp("^KeyRotationLogs") },
      },
    });
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      Name: "frontdoor-sandbox-key-rotation",
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
      LogGroupName: "/flex/frontdoor/sandbox/key-rotation",
    });
  });

  it("makes key pairs only under the signing key, by alias, for the caller token's purpose", () => {
    build().template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "frontdoor-sandbox-key-rotation",
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

  it("reads and writes only its state, the edge's signing keys, and the public keys' object", () => {
    build().template.hasResourceProperties("AWS::IAM::Role", {
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Effect: "Allow",
                Action: ["ssm:GetParameter", "ssm:PutParameter"],
                Resource: [
                  `arn:aws:ssm:eu-west-2:${ACCOUNT}:parameter/flex/frontdoor/sandbox/caller-token-key-state`,
                  `arn:aws:ssm:eu-west-2:${ACCOUNT}:parameter/flex/frontdoor/sandbox/caller-token-signing-key`,
                ],
              },
              {
                Effect: "Allow",
                Action: ["s3:GetObject", "s3:PutObject"],
                Resource: `arn:aws:s3:::frontdoor-sandbox-keys-${ACCOUNT}/caller-token-keys.json`,
                Condition: {
                  StringEquals: { "aws:ResourceAccount": ACCOUNT },
                },
              },
            ]),
          },
        },
      ],
    });
  });

  it("is run by a schedule whose role may only invoke the function, assumed only through the account's default schedule group", () => {
    build().template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "frontdoor-sandbox-key-rotation-schedule",
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

  it("is built in the signing region alone", () => {
    expect(() => build("us-east-1")).toThrow(
      "Key rotation runs in eu-west-2, beside the signing key, not us-east-1",
    );
  });

  it("has no unacknowledged cdk-nag finding", () => {
    expect(() => build("eu-west-2", true)).not.toThrow();
  });
});
