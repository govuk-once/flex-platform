import { PlatformLogGroup } from "@repo/infra-constructs";
import { ArnFormat, Stack, Validations } from "aws-cdk-lib";
import { Effect, ManagedPolicy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { LogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import {
  originRequestLogGroupName,
  originRequestLogsPolicyName,
} from "./names.ts";

export interface OriginRequestLogsProps {
  readonly environment: string;
}

/**
 * The origin request function's log group in this stack's region, and the policy that lets the
 * function's role write to it. The role is in another stack and attaches the policy by its name,
 * so the policy can name this log group and its key exactly.
 */
export class OriginRequestLogs extends Construct {
  public readonly logGroup: LogGroup;
  public readonly policy: ManagedPolicy;

  constructor(scope: Construct, id: string, props: OriginRequestLogsProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const logGroupName = originRequestLogGroupName(props.environment);
    const { logGroup, key } = new PlatformLogGroup(this, "Group", {
      logGroupName,
    });
    this.logGroup = logGroup;

    const logGroupArn = stack.formatArn({
      service: "logs",
      resource: "log-group",
      resourceName: logGroupName,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    const logStreams = `${logGroupArn}:*`;

    this.policy = new ManagedPolicy(this, "WritePolicy", {
      managedPolicyName: originRequestLogsPolicyName(
        props.environment,
        stack.region,
      ),
      statements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [logStreams],
        }),
        // Writing to a log group encrypted with a customer managed key takes the key too, through
        // CloudWatch Logs, for this log group alone.
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["kms:Encrypt", "kms:GenerateDataKey*"],
          resources: [key.keyArn],
          conditions: {
            StringEquals: {
              "kms:ViaService": `logs.${stack.region}.amazonaws.com`,
            },
            ArnEquals: { "kms:EncryptionContext:aws:logs:arn": logGroupArn },
          },
        }),
      ],
    });
    Validations.of(this.policy).acknowledge({
      id: `AwsSolutions-IAM5[Resource::${logStreams}]`,
      reason:
        "Lambda names each log stream itself, so the grant covers every stream in the one log group.",
    });
    Validations.of(this.policy).acknowledge({
      id: "AwsSolutions-IAM5[Action::kms:GenerateDataKey*]",
      reason:
        "CloudWatch Logs chooses which GenerateDataKey call it makes; the grant holds only for the one key and log group.",
    });
  }
}
