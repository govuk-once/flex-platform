import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildKeyRotationFunction,
  HANDLER,
} from "@repo/frontdoor-key-rotation";
import {
  SIGNING_KEY_PURPOSE,
  SIGNING_KEY_REGION,
} from "@repo/frontdoor-shared";
import {
  logGroupWriteStatements,
  PlatformLogGroup,
} from "@repo/infra-constructs";
import { Duration, Stack, Validations } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
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
  CALLER_TOKEN_KEYS_OBJECT,
  keyRotationAlarmName,
  keyRotationFunctionName,
  keyRotationLogGroupName,
  keyRotationRoleName,
  keyRotationScheduleRoleName,
  keyRotationStateParameterName,
  signingKeyAliasName,
  signingKeyParameterName,
} from "./names.ts";

/**
 * Often enough that a failed run is retried soon, and that a new environment's edge has a key
 * within minutes of its first deploy. A run with nothing due changes nothing.
 */
export const KEY_ROTATION_SCHEDULE = Duration.minutes(15);

export interface KeyRotationProps {
  readonly environment: string;
  /** The bucket every gateway reads the public keys from, in this account. */
  readonly publicKeysBucket: string;
  /** This account, which owns the bucket. */
  readonly publicKeysAccount: string;
  /** The bucket's region, the gateways' own. */
  readonly publicKeysRegion: string;
}

/**
 * The function that makes, schedules, publishes and removes the caller token's signing keys, on a
 * schedule. Only one copy runs at a time, so two runs never write the state at once.
 *
 * Its role may make key pairs only under the signing keys, found by alias, and bound to the caller
 * token's purpose; have KMS encrypt one again under the same key, which proves it decrypts without
 * returning it; and read and write only the state, the signing key parameters and the public keys'
 * object.
 */
export class KeyRotation extends Construct {
  public readonly function: LambdaFunction;
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
    const { environment } = props;

    const logGroupName = keyRotationLogGroupName(environment);
    const { logGroup, key: logGroupKey } = new PlatformLogGroup(this, "Logs", {
      logGroupName,
    });
    const logs = logGroupWriteStatements(this, { logGroupName, logGroupKey });

    const parameterArn = (name: string) =>
      stack.formatArn({
        service: "ssm",
        resource: "parameter",
        resourceName: name.replace(/^\//, ""),
      });
    const signingKey = stack.formatArn({
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
        resources: [signingKey],
        conditions: {
          "ForAnyValue:StringEquals": {
            "kms:ResourceAliases": signingKeyAliasName(environment),
          },
          StringEquals: {
            "kms:EncryptionContext:purpose": SIGNING_KEY_PURPOSE,
          },
        },
      }),
      // No Decrypt: this is how rotation checks a key decrypts. Only onto the same key, so a
      // private key is never encrypted again under one that someone else can use.
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["kms:ReEncryptFrom", "kms:ReEncryptTo"],
        resources: [signingKey],
        conditions: {
          "ForAnyValue:StringEquals": {
            "kms:ResourceAliases": signingKeyAliasName(environment),
          },
          StringEquals: {
            "kms:EncryptionContext:purpose": SIGNING_KEY_PURPOSE,
          },
          Bool: { "kms:ReEncryptOnSameKey": "true" },
        },
      }),
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [
          parameterArn(keyRotationStateParameterName(environment)),
          parameterArn(signingKeyParameterName(environment)),
        ],
      }),
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [
          `arn:${stack.partition}:s3:::${props.publicKeysBucket}/${CALLER_TOKEN_KEYS_OBJECT}`,
        ],
        // Bucket names are global: one of the same name in another account is never ours.
        conditions: {
          StringEquals: { "aws:ResourceAccount": props.publicKeysAccount },
        },
      }),
    ];

    const role = new Role(this, "Role", {
      roleName: keyRotationRoleName(environment),
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: { KeyRotation: new PolicyDocument({ statements }) },
    });

    this.function = new LambdaFunction(this, "Function", {
      functionName: keyRotationFunctionName(environment),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      handler: HANDLER,
      code: Code.fromAsset(
        bundleDirectory({
          keyAlias: signingKeyAliasName(environment),
          signingKeyParameter: signingKeyParameterName(environment),
          stateParameter: keyRotationStateParameterName(environment),
          publicKeysBucket: props.publicKeysBucket,
          publicKeysAccount: props.publicKeysAccount,
          publicKeysObject: CALLER_TOKEN_KEYS_OBJECT,
          publicKeysRegion: props.publicKeysRegion,
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
    const scheduleName = keyRotationFunctionName(environment);
    const scheduleRole = new Role(this, "SchedulerRole", {
      roleName: keyRotationScheduleRoleName(environment),
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
      description: "Runs the caller token's key rotation",
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
      alarmName: keyRotationAlarmName(environment),
      alarmDescription: `Key rotation in ${environment} failed in two of the last three ${KEY_ROTATION_SCHEDULE.toMinutes()}-minute periods. See the caller token page of the platform's docs, "When a run fails".`,
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
      id: `AwsSolutions-IAM5[Resource::${signingKey}]`,
      reason:
        "KMS generates the signing key's ID, so the grant names its alias by condition, which holds it to the one key.",
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
