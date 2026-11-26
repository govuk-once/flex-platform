import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildKeyRotationFunction,
  HANDLER,
  KEY_POLICIES,
  type KeyKind,
  type PublicationConfig,
} from "@repo/frontdoor-key-rotation";
import { SIGNING_KEY_REGION } from "@repo/frontdoor-shared";
import {
  logGroupWriteStatements,
  PlatformLogGroup,
  tablePolicy,
} from "@repo/infra-constructs";
import { Duration, RemovalPolicy, Stack, Validations } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import {
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { Construct } from "constructs";

import {
  keyRotationAlarmName,
  keyRotationFunctionName,
  keyRotationLogGroupName,
  keyRotationRoleName,
  keyRotationScheduleRoleName,
  privateKeysTableName,
  publicKeysTableName,
} from "./names.ts";

/**
 * Often enough that a failed run is retried soon, and that a new environment's edge has a key
 * within minutes of its first deploy. A run with nothing due changes nothing.
 */
export const KEY_ROTATION_SCHEDULE = Duration.minutes(15);

// All a reader does, and all rotation does: a run reads both tables whole, and changes them in one
// transaction of puts and deletes, which is authorised as the actions within it.
const READER_ACTIONS = ["dynamodb:Scan"];
const ROTATION_ACTIONS = [
  "dynamodb:DeleteItem",
  "dynamodb:PutItem",
  "dynamodb:Scan",
];

export interface KeyRotationProps {
  readonly environment: string;
  /** The kind of key, which chooses its policy and names its tables. */
  readonly kind: KeyKind;
  /** The alias of the KMS key that wraps the kind's private keys, in this account. */
  readonly keyAlias: string;
  /** The roles, by ARN, that may read the private keys besides rotation's own. */
  readonly privateKeyReaderRoleArns: readonly string[];
  /** Where the kind's public keys are published, for a kind whose policy publishes them. */
  readonly publication: PublicationConfig | null;
}

/**
 * The function that makes, schedules, publishes and removes one kind of key, on a schedule, and the
 * two tables it keeps them in. Only one copy runs at a time.
 *
 * Its role may make key pairs only under the kind's KMS key, found by alias, and bound to the
 * kind's purpose; have KMS encrypt one again under the same key, which proves it decrypts without
 * returning it; and read and change only its two tables and the published object.
 *
 * Each table's policy is a `tablePolicy`: anything to a reader but a scan, and anything to
 * rotation but its scans, puts and deletes, is denied, and so is anything else to anyone but
 * managing the table. Both tables are kept, with their backups, when the stack goes: without
 * them, no reader has a key.
 */
export class KeyRotation extends Construct {
  public readonly function: LambdaFunction;
  public readonly privateKeys: Table;
  public readonly publicKeys: Table;
  /**
   * Runs that failed in two of the last three periods. It has no actions, so it notifies no one.
   * One failed run doesn't set it off: the next run is the retry.
   */
  public readonly failedRuns: Alarm;

  constructor(scope: Construct, id: string, props: KeyRotationProps) {
    super(scope, id);

    const stack = Stack.of(this);
    if (stack.region !== SIGNING_KEY_REGION) {
      throw new Error(
        `Key rotation runs in ${SIGNING_KEY_REGION}, beside the signing key, not ${stack.region}`,
      );
    }
    const { environment, kind, keyAlias } = props;
    const { purpose } = KEY_POLICIES[kind];
    // As the docs name it, such as "caller token".
    const title = kind.replaceAll("-", " ");

    const roleArn = stack.formatArn({
      service: "iam",
      region: "",
      resource: "role",
      resourceName: keyRotationRoleName(environment, kind),
    });
    const privateKeysTable = privateKeysTableName(environment, kind);
    const publicKeysTable = publicKeysTableName(environment, kind);
    const tableArn = (name: string) =>
      stack.formatArn({
        service: "dynamodb",
        resource: "table",
        resourceName: name,
      });
    const table = (
      id: string,
      tableName: string,
      readerRoleArns: readonly string[],
    ) =>
      new Table(this, id, {
        tableName,
        partitionKey: { name: "keyId", type: AttributeType.STRING },
        billingMode: BillingMode.PAY_PER_REQUEST,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        deletionProtection: true,
        removalPolicy: RemovalPolicy.RETAIN,
        resourcePolicy: tablePolicy({
          // By name, since the policy is part of the table, which can't name its own ARN.
          tableArn: tableArn(tableName),
          roles: [
            {
              name: "KeyRotation",
              roleArns: [roleArn],
              actions: ROTATION_ACTIONS,
            },
            {
              name: "Readers",
              roleArns: readerRoleArns,
              actions: READER_ACTIONS,
            },
          ],
        }),
      });
    this.privateKeys = table(
      "PrivateKeys",
      privateKeysTable,
      props.privateKeyReaderRoleArns,
    );
    this.publicKeys = table("PublicKeys", publicKeysTable, []);

    const logGroupName = keyRotationLogGroupName(environment, kind);
    const { logGroup, key: logGroupKey } = new PlatformLogGroup(this, "Logs", {
      logGroupName,
    });
    const logs = logGroupWriteStatements(this, { logGroupName, logGroupKey });

    const kmsKey = stack.formatArn({
      service: "kms",
      resource: "key",
      resourceName: "*",
    });

    const statements = [
      ...logs.statements,
      // KMS generates the key's ID, so it is found by its alias.
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["kms:GenerateDataKeyPairWithoutPlaintext"],
        resources: [kmsKey],
        conditions: {
          "ForAnyValue:StringEquals": { "kms:ResourceAliases": keyAlias },
          StringEquals: { "kms:EncryptionContext:purpose": purpose },
        },
      }),
      // No Decrypt: this is how rotation checks a key decrypts. Only onto the same key, so a
      // private key is never encrypted again under one that someone else can use.
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["kms:ReEncryptFrom", "kms:ReEncryptTo"],
        resources: [kmsKey],
        conditions: {
          "ForAnyValue:StringEquals": { "kms:ResourceAliases": keyAlias },
          StringEquals: { "kms:EncryptionContext:purpose": purpose },
          Bool: { "kms:ReEncryptOnSameKey": "true" },
        },
      }),
      // A run reads both tables whole, and changes them in one transaction of puts and deletes.
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ROTATION_ACTIONS,
        resources: [tableArn(privateKeysTable), tableArn(publicKeysTable)],
      }),
      ...(props.publication === null
        ? []
        : [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["s3:GetObject", "s3:PutObject"],
              resources: [
                `arn:${stack.partition}:s3:::${props.publication.bucket}/${props.publication.object}`,
              ],
              // Bucket names are global: one of the same name in another account is never ours.
              conditions: {
                StringEquals: {
                  "aws:ResourceAccount": props.publication.account,
                },
              },
            }),
          ]),
    ];

    const role = new Role(this, "Role", {
      roleName: keyRotationRoleName(environment, kind),
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: { KeyRotation: new PolicyDocument({ statements }) },
    });

    this.function = new LambdaFunction(this, "Function", {
      functionName: keyRotationFunctionName(environment, kind),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      handler: HANDLER,
      code: Code.fromAsset(
        bundleDirectory({
          kind,
          keyAlias,
          privateKeysTable,
          publicKeysTable,
          publication: props.publication,
        }),
      ),
      role,
      timeout: Duration.minutes(1),
      memorySize: 256,
      reservedConcurrentExecutions: 1,
      logGroup,
    });

    // Written out rather than with CDK's Scheduler target, which makes its own role under an ID
    // derived from the stack, so the logical ID would differ between environments.
    const scheduleName = keyRotationFunctionName(environment, kind);
    const scheduleRole = new Role(this, "SchedulerRole", {
      roleName: keyRotationScheduleRoleName(environment, kind),
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com", {
        conditions: {
          // Scheduler gives its schedule group's ARN as the source, never the schedule's.
          StringEquals: {
            "aws:SourceAccount": stack.account,
            "aws:SourceArn": stack.formatArn({
              service: "scheduler",
              resource: "schedule-group",
              resourceName: "default",
            }),
          },
        },
      }),
      inlinePolicies: {
        InvokeKeyRotation: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["lambda:InvokeFunction"],
              resources: [this.function.functionArn],
            }),
          ],
        }),
      },
    });

    new CfnSchedule(this, "Scheduler", {
      name: scheduleName,
      description: `Runs the ${title} key rotation`,
      scheduleExpression: `rate(${KEY_ROTATION_SCHEDULE.toMinutes()} minutes)`,
      flexibleTimeWindow: { mode: "OFF" },
      state: "ENABLED",
      // The next run is the retry.
      target: {
        arn: this.function.functionArn,
        roleArn: scheduleRole.roleArn,
        retryPolicy: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 60 },
      },
    });

    this.failedRuns = new Alarm(this, "FailedRuns", {
      alarmName: keyRotationAlarmName(environment, kind),
      alarmDescription: `The ${title} key rotation in ${environment} failed in two of the last three ${KEY_ROTATION_SCHEDULE.toMinutes()}-minute periods. See the ${title} page of the platform's docs, "When a run fails".`,
      metric: this.function.metricErrors({
        statistic: "Sum",
        period: KEY_ROTATION_SCHEDULE,
      }),
      threshold: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      // Two of three, since a run close to a period's edge can fall either side of it.
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      // Lambda publishes nothing for a period with no run.
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    Validations.of(role).acknowledge(...logs.acknowledgements, {
      id: `AwsSolutions-IAM5[Resource::${kmsKey}]`,
      reason:
        "KMS generates the key's ID, so the grant names its alias by condition, which holds it to the one key.",
    });
  }
}

// The bundle is per environment, so it's built at synth, into a directory of its own for CDK to
// stage.
function bundleDirectory(
  config: Parameters<typeof buildKeyRotationFunction>[0],
): string {
  const directory = mkdtempSync(path.join(tmpdir(), "key-rotation-"));
  writeFileSync(
    path.join(directory, "index.js"),
    buildKeyRotationFunction(config),
  );
  return directory;
}
