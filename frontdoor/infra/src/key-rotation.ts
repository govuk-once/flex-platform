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
import { PlatformLogGroup } from "@repo/infra-constructs";
import { ArnFormat, Duration, Stack, Validations } from "aws-cdk-lib";
import { CfnRule } from "aws-cdk-lib/aws-events";
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
import { Construct } from "constructs";

import {
  CALLER_TOKEN_KEYS_OBJECT,
  keyRotationFunctionName,
  keyRotationLogGroupName,
  keyRotationRoleName,
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
 * token's purpose; and read and write only the state, the signing key parameters and the public
 * keys' object.
 */
export class KeyRotation extends Construct {
  public readonly function: LambdaFunction;

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
    const logGroupArn = stack.formatArn({
      service: "logs",
      resource: "log-group",
      resourceName: logGroupName,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

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
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [`${logGroupArn}:*`],
      }),
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["kms:Encrypt", "kms:GenerateDataKey*"],
        resources: [logGroupKey.keyArn],
        conditions: {
          StringEquals: {
            "kms:ViaService": `logs.${stack.region}.amazonaws.com`,
          },
          ArnEquals: { "kms:EncryptionContext:aws:logs:arn": logGroupArn },
        },
      }),
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

    // Written out rather than with CDK's Lambda target, which names its permission after the stack,
    // so the logical ID would differ between environments.
    const schedule = new CfnRule(this, "Schedule", {
      name: keyRotationFunctionName(environment),
      description: "Runs the caller token's key rotation",
      scheduleExpression: `rate(${KEY_ROTATION_SCHEDULE.toMinutes()} minutes)`,
      state: "ENABLED",
      // The next run is the retry.
      targets: [
        {
          id: "KeyRotation",
          arn: this.function.functionArn,
          retryPolicy: { maximumRetryAttempts: 0 },
        },
      ],
    });
    this.function.addPermission("Schedule", {
      principal: new ServicePrincipal("events.amazonaws.com"),
      sourceArn: schedule.attrArn,
    });

    Validations.of(role).acknowledge(
      {
        id: `AwsSolutions-IAM5[Resource::${logGroupArn}:*]`,
        reason:
          "Lambda names each log stream itself, so the grant covers every stream in the function's own log group.",
      },
      {
        id: "AwsSolutions-IAM5[Action::kms:GenerateDataKey*]",
        reason:
          "CloudWatch Logs chooses which GenerateDataKey call it makes; the grant holds only for the one key and log group.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${signingKey}]`,
        reason:
          "KMS generates the signing key's ID, so the grant names its alias by condition, which holds it to the one key.",
      },
    );
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
