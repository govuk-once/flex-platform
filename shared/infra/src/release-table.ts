import { RemovalPolicy, Stack } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import {
  AnyPrincipal,
  Effect,
  PolicyDocument,
  PolicyStatement,
} from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

import { RELEASE_TABLE_NAME } from "./names.ts";

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
 * The table's policy denies, to anyone, recording a release unless it is the API's role, changing
 * one unless it is the API's or the worker's, and deleting one. A deny there holds whatever any
 * principal's own policy allows. Kept, with its backups, when the stack goes: it is the record of
 * what was released.
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
    const deny = (
      sid: string,
      actions: string[],
      exceptRoleArns: string[] = [],
    ) =>
      new PolicyStatement({
        sid,
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions,
        resources: [tableArn],
        ...(exceptRoleArns.length > 0 && {
          conditions: {
            ArnNotEquals: { "aws:PrincipalArn": exceptRoleArns },
          },
        }),
      });

    this.table = new Table(this, "Table", {
      tableName: RELEASE_TABLE_NAME,
      partitionKey: { name: "target", type: AttributeType.STRING },
      sortKey: { name: "id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      resourcePolicy: new PolicyDocument({
        statements: [
          // PartiQL's statements are authorised as their own actions.
          deny(
            "DenyRecordingButThePipelineApi",
            ["dynamodb:PartiQLInsert", "dynamodb:PutItem"],
            [props.recorderRoleArn],
          ),
          deny(
            "DenyChangingButTheApiAndWorker",
            ["dynamodb:PartiQLUpdate", "dynamodb:UpdateItem"],
            [props.recorderRoleArn, ...props.workerRoleArns],
          ),
          // A batch write can put an item as well as delete one, and nothing here makes one.
          deny("DenyDeleting", [
            "dynamodb:BatchWriteItem",
            "dynamodb:DeleteItem",
            "dynamodb:PartiQLDelete",
          ]),
        ],
      }),
    });
  }
}
