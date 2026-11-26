import { tablePolicy } from "@repo/infra-constructs";
import { RemovalPolicy, Stack } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

import { ARTEFACT_TABLE_NAME } from "./names.ts";

/**
 * All the pipeline API does to the table: claim each version for its bundle, and find the bundle a
 * release names. A version is never changed, so there is no update.
 */
export const ARTEFACT_RECORDER_ACTIONS = [
  "dynamodb:GetItem",
  "dynamodb:PutItem",
];

export interface ArtefactTableProps {
  /** The pipeline API's role, by ARN: the one role that may record a version. */
  readonly recorderRoleArn: string;
}

/**
 * Each version a domain has uploaded, under its domain, by version, with the hash of the bundle it
 * names. The pipeline API records a version when it signs its upload, and a release takes its
 * bundle from here.
 *
 * The table's policy is a `tablePolicy`: anything to the API's role but its gets and puts, and
 * anything else to anyone but managing the table, is denied. The API records a version only where
 * there is none, so a version names one bundle for good. Kept, with its backups, when the stack
 * goes: it says what each version a domain released was.
 */
export class ArtefactTable extends Construct {
  public readonly table: Table;

  constructor(scope: Construct, id: string, props: ArtefactTableProps) {
    super(scope, id);

    this.table = new Table(this, "Table", {
      tableName: ARTEFACT_TABLE_NAME,
      partitionKey: { name: "domain", type: AttributeType.STRING },
      sortKey: { name: "version", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      resourcePolicy: tablePolicy({
        // By name, since the policy is part of the table, which can't name its own ARN.
        tableArn: Stack.of(this).formatArn({
          service: "dynamodb",
          resource: "table",
          resourceName: ARTEFACT_TABLE_NAME,
        }),
        roles: [
          {
            name: "PipelineApi",
            roleArns: [props.recorderRoleArn],
            actions: ARTEFACT_RECORDER_ACTIONS,
          },
        ],
      }),
    });
  }
}
