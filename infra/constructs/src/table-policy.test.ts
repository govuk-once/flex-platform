import { Stack } from "aws-cdk-lib";
import { AnyPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { describe, expect, it } from "vitest";

import { cdkApp } from "./cdk-app.ts";
import { TABLE_MANAGEMENT_ACTIONS, tablePolicy } from "./table-policy.ts";

const TABLE = "arn:aws:dynamodb:eu-west-2:123456789012:table/test";
const WRITER = "arn:aws:iam::123456789012:role/test-writer";
const READER = "arn:aws:iam::123456789012:role/test-reader";
const PATTERN = "arn:aws:iam::100000000003:role/test-*";

function resolved(document: ReturnType<typeof tablePolicy>): unknown {
  const stack = new Stack(cdkApp(), "Test");
  return stack.resolve(document.toJSON());
}

const deny = (Sid: string, NotAction: unknown, Condition?: object) => ({
  Sid,
  Effect: "Deny",
  Principal: { AWS: "*" },
  NotAction,
  // The table and every index of it, which is a resource of its own.
  Resource: [TABLE, `${TABLE}/index/*`],
  ...(Condition !== undefined && { Condition }),
});

describe("tablePolicy", () => {
  it("denies others all but managing the table, and each set of roles all but its work, on the table and its indexes", () => {
    const allow = new PolicyStatement({
      sid: "AllowReaders",
      effect: Effect.ALLOW,
      principals: [new AnyPrincipal()],
      actions: ["dynamodb:Scan"],
      resources: [TABLE],
    });
    expect(
      resolved(
        tablePolicy({
          tableArn: TABLE,
          roles: [
            {
              name: "Writer",
              roleArns: [WRITER],
              actions: ["dynamodb:PutItem", "dynamodb:Scan"],
            },
            {
              name: "Readers",
              roleArns: [READER, PATTERN, READER],
              actions: ["dynamodb:Scan"],
            },
          ],
          statements: [allow],
        }),
      ),
    ).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "AllowReaders",
          Effect: "Allow",
          Principal: { AWS: "*" },
          Action: "dynamodb:Scan",
          Resource: TABLE,
        },
        deny(
          "DenyOthersAllButManagingTheTable",
          [...TABLE_MANAGEMENT_ACTIONS],
          {
            ArnNotLike: { "aws:PrincipalArn": [PATTERN, READER, WRITER] },
          },
        ),
        deny("DenyWriterAllButItsWork", ["dynamodb:PutItem", "dynamodb:Scan"], {
          ArnLike: { "aws:PrincipalArn": [WRITER] },
        }),
        deny("DenyReadersAllButItsWork", "dynamodb:Scan", {
          ArnLike: { "aws:PrincipalArn": [PATTERN, READER] },
        }),
      ],
    });
  });

  // So a deploy works under whatever role it runs as, and the policy can always be rewritten.
  it("never denies changing the table or its policy, nor reads or writes an item for anyone", () => {
    expect(TABLE_MANAGEMENT_ACTIONS).toEqual([
      "dynamodb:DeleteResourcePolicy",
      "dynamodb:Describe*",
      "dynamodb:GetResourcePolicy",
      "dynamodb:ListTagsOfResource",
      "dynamodb:PutResourcePolicy",
      "dynamodb:TagResource",
      "dynamodb:UntagResource",
      "dynamodb:UpdateContinuousBackups",
      "dynamodb:UpdateContributorInsights",
      "dynamodb:UpdateTable",
    ]);
    for (const action of TABLE_MANAGEMENT_ACTIONS) {
      expect(action).not.toMatch(
        /Item|PartiQL|Query|Scan|Export|Import|CreateBackup|Restore|Replica|Kinesis/,
      );
    }
  });

  // One set on an attribute that holds a time would delete every item that has it.
  it("lets no one set a time to live", () => {
    expect(TABLE_MANAGEMENT_ACTIONS).not.toContain("dynamodb:UpdateTimeToLive");
    expect(
      TABLE_MANAGEMENT_ACTIONS.filter((action) => action.endsWith("*")),
    ).toEqual(["dynamodb:Describe*"]);
  });

  it("leaves out a set with no roles", () => {
    expect(
      resolved(
        tablePolicy({
          tableArn: TABLE,
          roles: [
            {
              name: "Writer",
              roleArns: [WRITER],
              actions: ["dynamodb:PutItem"],
            },
            { name: "Readers", roleArns: [], actions: ["dynamodb:Scan"] },
          ],
        }),
      ),
    ).toEqual({
      Version: "2012-10-17",
      Statement: [
        deny(
          "DenyOthersAllButManagingTheTable",
          [...TABLE_MANAGEMENT_ACTIONS],
          {
            ArnNotLike: { "aws:PrincipalArn": [WRITER] },
          },
        ),
        deny("DenyWriterAllButItsWork", "dynamodb:PutItem", {
          ArnLike: { "aws:PrincipalArn": [WRITER] },
        }),
      ],
    });
  });

  it("denies everyone all but managing the table when it names no role", () => {
    expect(resolved(tablePolicy({ tableArn: TABLE, roles: [] }))).toEqual({
      Version: "2012-10-17",
      Statement: [
        deny("DenyOthersAllButManagingTheTable", [...TABLE_MANAGEMENT_ACTIONS]),
      ],
    });
  });

  // Each set's deny would refuse the other's work.
  it("refuses a role in two sets", () => {
    expect(() =>
      tablePolicy({
        tableArn: TABLE,
        roles: [
          { name: "Writer", roleArns: [WRITER], actions: ["dynamodb:PutItem"] },
          { name: "Readers", roleArns: [WRITER], actions: ["dynamodb:Scan"] },
        ],
      }),
    ).toThrow(`A table's policy names ${WRITER} in two sets of roles`);
  });
});
