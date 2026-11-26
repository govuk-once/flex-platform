import { TABLE_MANAGEMENT_ACTIONS } from "@repo/infra-constructs";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ACCOUNT, appOf, stackIn } from "../test/helpers.ts";
import { ArtefactTable } from "./artefact-table.ts";

const RECORDER = `arn:aws:iam::${ACCOUNT}:role/shared-ci`;

const TABLE_ARN = `arn:aws:dynamodb:eu-west-2:${ACCOUNT}:table/shared-release-artefacts`;

function build(nag = false) {
  const stack = stackIn("eu-west-2", nag);
  new ArtefactTable(stack, "Artefacts", { recorderRoleArn: RECORDER });
  return stack;
}

describe("ArtefactTable", () => {
  it("passes cdk-nag", () => {
    expect(() => appOf(build(true)).synth()).not.toThrow();
  });

  it("keys each version by its domain, then the version, and keeps it", () => {
    Template.fromStack(build()).hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        TableName: "shared-release-artefacts",
        KeySchema: [
          { AttributeName: "domain", KeyType: "HASH" },
          { AttributeName: "version", KeyType: "RANGE" },
        ],
        BillingMode: "PAY_PER_REQUEST",
        DeletionProtectionEnabled: true,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      },
    });
  });

  // An admin of the account can't either, short of rewriting the policy: a deny in the table's
  // policy holds over any allow.
  it("lets the API's role alone get and put a version, and nothing change or delete one", () => {
    Template.fromStack(build()).hasResourceProperties("AWS::DynamoDB::Table", {
      ResourcePolicy: {
        PolicyDocument: {
          Statement: [
            {
              Sid: "DenyOthersAllButManagingTheTable",
              Effect: "Deny",
              Principal: { AWS: "*" },
              NotAction: [...TABLE_MANAGEMENT_ACTIONS],
              Resource: TABLE_ARN,
              Condition: { ArnNotLike: { "aws:PrincipalArn": [RECORDER] } },
            },
            {
              Sid: "DenyPipelineApiAllButItsWork",
              Effect: "Deny",
              Principal: { AWS: "*" },
              NotAction: ["dynamodb:GetItem", "dynamodb:PutItem"],
              Resource: TABLE_ARN,
              Condition: { ArnLike: { "aws:PrincipalArn": [RECORDER] } },
            },
          ],
          Version: "2012-10-17",
        },
      },
    });
  });
});
