import { tablePolicy } from "@repo/infra-constructs";
import { FIXED_ATTRIBUTES } from "@repo/shared-release/table";
import { RemovalPolicy, Stack } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { AnyPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

import { RELEASE_TABLE_NAME } from "./names.ts";

/**
 * All the pipeline API does to the table: record each release, record one the queue wouldn't take
 * as refused, and answer how one went.
 */
export const RELEASE_RECORDER_ACTIONS = [
  "dynamodb:GetItem",
  "dynamodb:PutItem",
  "dynamodb:UpdateItem",
];

/** All a worker does to the table: read a release, and change how it is going. */
export const RELEASE_WORKER_ACTIONS = [
  "dynamodb:GetItem",
  "dynamodb:UpdateItem",
];

export interface ReleaseTableProps {
  /** The pipeline API's role, by ARN: the one role that may record a release. */
  readonly recorderRoleArn: string;
  /** The roles, by ARN, that may change a release, as the API's may: the workers'. */
  readonly workerRoleArns: readonly string[];
}

/**
 * Every release the pipeline API records, under its domain in its environment, sorted by ID, which
 * sorts by when it was asked for. The worker reads what to release from here, not from the
 * message, so a release is only one the API recorded.
 *
 * The table's policy is a `tablePolicy`: anything to the API's role but its gets, puts and
 * updates, anything to a worker's but its gets and updates, and anything else to anyone but
 * managing the table, is denied. It also denies, to anyone, changing what was asked for. Kept,
 * with its backups, when the stack goes: it is the record of what was released.
 */
export class ReleaseTable extends Construct {
  public readonly table: Table;

  constructor(scope: Construct, id: string, props: ReleaseTableProps) {
    super(scope, id);

    // By name, since the policy is part of the table, which can't name its own ARN.
    const tableArn = Stack.of(this).formatArn({
      service: "dynamodb",
      resource: "table",
      resourceName: RELEASE_TABLE_NAME,
    });

    this.table = new Table(this, "Table", {
      tableName: RELEASE_TABLE_NAME,
      partitionKey: { name: "target", type: AttributeType.STRING },
      sortKey: { name: "id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      resourcePolicy: tablePolicy({
        tableArn,
        roles: [
          {
            name: "PipelineApi",
            roleArns: [props.recorderRoleArn],
            actions: RELEASE_RECORDER_ACTIONS,
          },
          {
            name: "Workers",
            roleArns: props.workerRoleArns,
            actions: RELEASE_WORKER_ACTIONS,
          },
        ],
        statements: [
          // Each writer changes only how a release is going. A role that could change what was
          // asked for could have the worker release a bundle no pipeline asked for. An update can
          // also make an item, which then holds none of these, so isn't a release.
          new PolicyStatement({
            sid: "DenyChangingWhatWasAsked",
            effect: Effect.DENY,
            principals: [new AnyPrincipal()],
            actions: ["dynamodb:UpdateItem"],
            resources: [tableArn],
            conditions: {
              "ForAnyValue:StringEquals": {
                "dynamodb:Attributes": [...FIXED_ATTRIBUTES],
              },
            },
          }),
        ],
      }),
    });
  }
}
