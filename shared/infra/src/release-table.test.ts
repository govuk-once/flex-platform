import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ACCOUNT, appOf, stackIn } from "../test/helpers.ts";
import { ReleaseTable } from "./release-table.ts";

const RECORDER = `arn:aws:iam::${ACCOUNT}:role/shared-ci`;

const WORKER = `arn:aws:iam::${ACCOUNT}:role/shared-release-worker`;

const TABLE_ARN = `arn:aws:dynamodb:eu-west-2:${ACCOUNT}:table/shared-releases`;

function build(nag = false) {
  const stack = stackIn("eu-west-2", nag);
  new ReleaseTable(stack, "Releases", {
    recorderRoleArn: RECORDER,
    workerRoleArns: [WORKER],
  });
  return stack;
}

describe("ReleaseTable", () => {
  it("passes cdk-nag", () => {
    expect(() => appOf(build(true)).synth()).not.toThrow();
  });

  it("keys each release by its domain in its environment, then its ID, and keeps it", () => {
    Template.fromStack(build()).hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        TableName: "shared-releases",
        KeySchema: [
          { AttributeName: "target", KeyType: "HASH" },
          { AttributeName: "id", KeyType: "RANGE" },
        ],
        BillingMode: "PAY_PER_REQUEST",
        DeletionProtectionEnabled: true,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      },
    });
  });

  // An admin of the account can't either: a deny in the table's policy holds over any allow.
  it("lets no role but the API's record a release, none but the API's and the worker's change one, none change what was asked for, and none delete one", () => {
    Template.fromStack(build()).hasResourceProperties("AWS::DynamoDB::Table", {
      ResourcePolicy: {
        PolicyDocument: {
          Statement: [
            {
              Sid: "DenyRecordingButThePipelineApi",
              Effect: "Deny",
              Principal: { AWS: "*" },
              Action: "dynamodb:PutItem",
              Resource: TABLE_ARN,
              Condition: { ArnNotEquals: { "aws:PrincipalArn": [RECORDER] } },
            },
            {
              Sid: "DenyChangingButTheApiAndWorker",
              Effect: "Deny",
              Principal: { AWS: "*" },
              Action: "dynamodb:UpdateItem",
              Resource: TABLE_ARN,
              Condition: {
                ArnNotEquals: { "aws:PrincipalArn": [RECORDER, WORKER] },
              },
            },
            {
              Sid: "DenyChangingWhatWasAsked",
              Effect: "Deny",
              Principal: { AWS: "*" },
              Action: "dynamodb:UpdateItem",
              Resource: TABLE_ARN,
              Condition: {
                "ForAnyValue:StringEquals": {
                  "dynamodb:Attributes": [
                    "environment",
                    "domain",
                    "version",
                    "sha256",
                    "versionId",
                    "runId",
                    "commit",
                    "requestedAt",
                  ],
                },
              },
            },
            {
              Sid: "DenyPartiQLChanges",
              Effect: "Deny",
              Principal: { AWS: "*" },
              Action: ["dynamodb:PartiQLInsert", "dynamodb:PartiQLUpdate"],
              Resource: TABLE_ARN,
            },
            {
              Sid: "DenyDeleting",
              Effect: "Deny",
              Principal: { AWS: "*" },
              Action: [
                "dynamodb:BatchWriteItem",
                "dynamodb:DeleteItem",
                "dynamodb:PartiQLDelete",
              ],
              Resource: TABLE_ARN,
            },
          ],
          Version: "2012-10-17",
        },
      },
    });
  });
});
