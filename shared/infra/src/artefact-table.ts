import { RemovalPolicy, Stack } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import {
  AnyPrincipal,
  Effect,
  PolicyDocument,
  PolicyStatement,
} from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

import { ARTEFACT_TABLE_NAME } from "./names.ts";

export interface ArtefactTableProps {
  /** The pipeline API's role, by ARN: the one role that may record a version. */
  readonly recorderRoleArn: string;
}

/**
 * Each version a domain has uploaded, under its domain, by version, with the hash of the bundle it
 * names. The pipeline API records a version when it signs its upload, and a release takes its
 * bundle from here.
 *
 * The table's policy denies, to anyone, recording a version unless it is the API's role, and
 * changing or deleting one at all, so a version names one bundle for good. A deny there holds
 * whatever any principal's own policy allows. Kept, with its backups, when the stack goes: it says
 * what each version a domain released was.
 */
export class ArtefactTable extends Construct {
  public readonly table: Table;

  constructor(scope: Construct, id: string, props: ArtefactTableProps) {
    super(scope, id);

    // By name, since the policy is part of the table, which can't name its own ARN.
    const tableArn = Stack.of(this).formatArn({
      service: "dynamodb",
      resource: "table",
      resourceName: ARTEFACT_TABLE_NAME,
    });
    const deny = (
      sid: string,
      actions: string[],
      conditions?: Record<string, Record<string, string[]>>,
    ) =>
      new PolicyStatement({
        sid,
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions,
        resources: [tableArn],
        ...(conditions !== undefined && { conditions }),
      });

    this.table = new Table(this, "Table", {
      tableName: ARTEFACT_TABLE_NAME,
      partitionKey: { name: "domain", type: AttributeType.STRING },
      sortKey: { name: "version", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      resourcePolicy: new PolicyDocument({
        statements: [
          deny("DenyRecordingButThePipelineApi", ["dynamodb:PutItem"], {
            ArnNotEquals: { "aws:PrincipalArn": [props.recorderRoleArn] },
          }),
          // The API records a version only where there is none, so nothing needs to change one.
          // A batch write can put an item as well as delete one, and PartiQL's statements are
          // authorised as their own actions. Nothing here uses either.
          deny("DenyChanging", [
            "dynamodb:BatchWriteItem",
            "dynamodb:DeleteItem",
            "dynamodb:PartiQLDelete",
            "dynamodb:PartiQLInsert",
            "dynamodb:PartiQLUpdate",
            "dynamodb:UpdateItem",
          ]),
        ],
      }),
    });
  }
}
