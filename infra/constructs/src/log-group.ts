import { ArnFormat, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Effect, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import { LOG_RETENTION } from "./validation/log-group-check.ts";

export interface PlatformLogGroupProps {
  /** Named only where something requires it, such as WAF's `aws-waf-logs-` prefix. */
  readonly logGroupName?: string;
}

// The construct ID of each stack's log group key, at the stack's root.
const LOG_GROUP_KEY_ID = "LogGroupKey";

/**
 * A log group of the platform's: kept for a year, encrypted with its stack's own KMS key, and
 * retained when its stack is deleted. Log forwarding will carry every account's log groups to the
 * shared account, which is where any longer term copy is made, so retention here is the same
 * everywhere.
 */
export class PlatformLogGroup extends Construct {
  public readonly logGroup: LogGroup;
  /** The stack's log group key, which a principal writing to the log group itself must use. */
  public readonly key: Key;

  constructor(scope: Construct, id: string, props: PlatformLogGroupProps = {}) {
    super(scope, id);

    this.key = logGroupKey(Stack.of(this));
    this.logGroup = new LogGroup(this, "LogGroup", {
      retention: LOG_RETENTION,
      removalPolicy: RemovalPolicy.RETAIN,
      encryptionKey: this.key,
      ...(props.logGroupName !== undefined && {
        logGroupName: props.logGroupName,
      }),
    });
  }
}

// One key per stack, and so per account and region, as CloudWatch Logs needs. It is retained, as
// the log groups are, or they couldn't be read.
function logGroupKey(stack: Stack): Key {
  const existing = stack.node.tryFindChild(LOG_GROUP_KEY_ID);
  if (existing instanceof Key) return existing;

  const key = new Key(stack, LOG_GROUP_KEY_ID, {
    description: `Encrypts the log groups of ${stack.stackName}`,
    enableKeyRotation: true,
    removalPolicy: RemovalPolicy.RETAIN,
  });
  key.addToResourcePolicy(
    new PolicyStatement({
      sid: "AllowCloudWatchLogs",
      effect: Effect.ALLOW,
      principals: [new ServicePrincipal(`logs.${stack.region}.amazonaws.com`)],
      actions: [
        "kms:Encrypt*",
        "kms:Decrypt*",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:Describe*",
      ],
      resources: ["*"],
      conditions: {
        ArnLike: {
          "kms:EncryptionContext:aws:logs:arn": stack.formatArn({
            service: "logs",
            resource: "log-group",
            resourceName: "*",
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        },
      },
    }),
  );
  return key;
}
