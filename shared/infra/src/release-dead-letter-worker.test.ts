import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { assert, describe, expect, it } from "vitest";

import { ACCOUNT, appOf, stackIn } from "../test/helpers.ts";
import { ReleaseDeadLetterWorker } from "./release-dead-letter-worker.ts";

const TABLE_ARN = `arn:aws:dynamodb:eu-west-2:${ACCOUNT}:table/shared-releases`;

function build(nag = false) {
  const stack = stackIn("eu-west-2", nag);
  const deadLetters = new Queue(stack, "DeadLetters", {
    queueName: "shared-release-dead-letter.fifo",
    fifo: true,
    enforceSSL: true,
  });
  // A stand-in for the release worker's, which acknowledges this itself.
  Validations.of(deadLetters).acknowledge({
    id: "AwsSolutions-SQS3",
    reason: "A dead-letter queue.",
  });
  new ReleaseDeadLetterWorker(stack, "DeadLetterWorker", {
    deadLetters,
    releaseTable: { name: "shared-releases", arn: TABLE_ARN },
  });
  return stack;
}

function template(): Template {
  return Template.fromStack(build());
}

describe("ReleaseDeadLetterWorker", () => {
  it("passes cdk-nag and the platform's log group check", () => {
    expect(() => appOf(build(true)).synth()).not.toThrow();
  });

  it("reads the dead-letter queue one message at a time, giving back only one it couldn't record", () => {
    const built = template();

    built.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "shared-release-dead-letter-worker",
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      Timeout: 30,
      LoggingConfig: {
        LogGroup: { Ref: Match.stringLikeRegexp("^DeadLetterWorkerLogs") },
      },
    });
    built.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      EventSourceArn: {
        "Fn::GetAtt": [Match.stringLikeRegexp("^DeadLetters"), "Arn"],
      },
      BatchSize: 1,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
    built.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
      Properties: {
        LogGroupName: "/flex/shared/release-dead-letter-worker",
      },
    });
  });

  it("may take the dead-letter queue's messages and read and change a release, and nothing else", () => {
    const built = template();
    const [role] = Object.values(built.findResources("AWS::IAM::Role"));
    const statements = (
      role?.Properties as {
        RoleName: string;
        Policies: {
          PolicyDocument: {
            Statement: { Action: string | string[]; Resource: unknown }[];
          };
        }[];
      }
    ).Policies.flatMap(({ PolicyDocument }) => PolicyDocument.Statement);

    built.resourceCountIs("AWS::IAM::Policy", 0);
    expect(
      statements.map(({ Action, Resource }) => [Action, Resource]),
    ).toEqual([
      [["logs:CreateLogStream", "logs:PutLogEvents"], expect.anything()],
      [["kms:Encrypt", "kms:GenerateDataKey*"], expect.anything()],
      [
        [
          "sqs:ChangeMessageVisibility",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:ReceiveMessage",
        ],
        { "Fn::GetAtt": [expect.stringMatching(/^DeadLetters/), "Arn"] },
      ],
      [["dynamodb:GetItem", "dynamodb:UpdateItem"], TABLE_ARN],
    ]);
  });

  it("lets no role but its own take a message from the dead-letter queue", () => {
    template().hasResourceProperties("AWS::SQS::QueuePolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Sid: "DenyTakingButTheDeadLetterWorker",
            Effect: "Deny",
            Principal: { AWS: "*" },
            Action: [
              "sqs:ChangeMessageVisibility",
              "sqs:DeleteMessage",
              "sqs:ReceiveMessage",
            ],
            Resource: {
              "Fn::GetAtt": [Match.stringLikeRegexp("^DeadLetters"), "Arn"],
            },
            Condition: {
              ArnNotEquals: {
                "aws:PrincipalArn": {
                  "Fn::GetAtt": [
                    Match.stringLikeRegexp("^DeadLetterWorkerRole"),
                    "Arn",
                  ],
                },
              },
            },
          },
        ]),
      },
    });
  });

  it.each([
    ["shared-release-abandoned", "release_abandoned"],
    ["shared-release-abandon-failed", "release_failed"],
  ])("alarms as %s on any %s in its log", (name, event) => {
    const built = template();

    built.hasResourceProperties("AWS::Logs::MetricFilter", {
      FilterPattern: `{ $.telemetry.event = "${event}" }`,
      LogGroupName: {
        Ref: Match.stringLikeRegexp("^DeadLetterWorkerLogs"),
      },
      MetricTransformations: [
        {
          MetricNamespace: "flex/shared/release",
          MetricName: name,
          MetricValue: "1",
        },
      ],
    });
    built.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: name,
      MetricName: name,
      Namespace: "flex/shared/release",
      Statistic: "Sum",
      Period: 300,
      Threshold: 1,
      EvaluationPeriods: 1,
      TreatMissingData: "notBreaching",
      AlarmActions: Match.absent(),
    });
  });

  it("is built with the release table, and none of the release worker's config", () => {
    const { directory } = appOf(build()).synth();
    const [asset] = readdirSync(directory).filter((name) =>
      name.startsWith("asset."),
    );
    assert(asset !== undefined);
    const code = readFileSync(path.join(directory, asset, "index.js"), "utf8");

    expect(code).toContain('table: "shared-releases"');
    expect(code).not.toContain("deployRoleArn");
  });
});
