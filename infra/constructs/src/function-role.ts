import { type Acknowledgment, ArnFormat, Stack } from "aws-cdk-lib";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { IKey } from "aws-cdk-lib/aws-kms";
import type { IConstruct } from "constructs";

// Lambda creates, reuses and removes a function's network interfaces in its subnets as the
// function's role.
const NETWORK_INTERFACE_ACTIONS = [
  "ec2:AssignPrivateIpAddresses",
  "ec2:CreateNetworkInterface",
  "ec2:DeleteNetworkInterface",
  "ec2:DescribeNetworkInterfaces",
  "ec2:DescribeSubnets",
  "ec2:UnassignPrivateIpAddresses",
];

export interface RoleStatements {
  readonly statements: PolicyStatement[];
  /** cdk-nag's findings on the statements' wildcards, acknowledged with the reason for each. */
  readonly acknowledgements: Acknowledgment[];
}

export interface LogGroupWriteStatementsProps {
  /** The log group the function writes to. */
  readonly logGroupName: string;
  /** The key the log group is encrypted with. */
  readonly logGroupKey: IKey;
}

/** What a function's role needs to write to its own log group, and to no other. */
export function logGroupWriteStatements(
  scope: IConstruct,
  { logGroupName, logGroupKey }: LogGroupWriteStatementsProps,
): RoleStatements {
  const stack = Stack.of(scope);

  const logGroupArn = stack.formatArn({
    service: "logs",
    resource: "log-group",
    resourceName: logGroupName,
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });
  const logStreams = `${logGroupArn}:*`;

  return {
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
        resources: [logGroupKey.keyArn],
        conditions: {
          StringEquals: {
            "kms:ViaService": `logs.${stack.region}.amazonaws.com`,
          },
          ArnEquals: { "kms:EncryptionContext:aws:logs:arn": logGroupArn },
        },
      }),
    ],
    acknowledgements: [
      {
        id: `AwsSolutions-IAM5[Resource::${logStreams}]`,
        reason:
          "Lambda names each log stream itself, so the grant covers every stream in the function's own log group.",
      },
      {
        id: "AwsSolutions-IAM5[Action::kms:GenerateDataKey*]",
        reason:
          "CloudWatch Logs chooses which GenerateDataKey call it makes; the grant holds only for the one key and log group.",
      },
    ],
  };
}

export interface FunctionRoleStatementsProps extends LogGroupWriteStatementsProps {
  /** Every function of the role's kind in the environment, as a name pattern such as `gateway-dev-*`. */
  readonly functions: string;
}

/**
 * What every role a platform function in a VPC runs as needs: to write to its own log group, and
 * for Lambda to manage the function's network interfaces, which the function's own code may not.
 * The network interface grant's `*` is the caller's to acknowledge, with every other action of its
 * own that takes it.
 */
export function functionRoleStatements(
  scope: IConstruct,
  { functions, ...logs }: FunctionRoleStatementsProps,
): RoleStatements {
  const { statements, acknowledgements } = logGroupWriteStatements(scope, logs);

  const functionArns = Stack.of(scope).formatArn({
    service: "lambda",
    resource: "function",
    resourceName: functions,
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });

  return {
    statements: [
      ...statements,
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: NETWORK_INTERFACE_ACTIONS,
        resources: ["*"],
      }),
      // The function's code holds the role's credentials too. Lambda's own calls to manage its
      // network interfaces carry no source function, so this denies only the code's. It names
      // every function of the kind, so it holds even if the role is ever given to another's.
      new PolicyStatement({
        effect: Effect.DENY,
        actions: [...NETWORK_INTERFACE_ACTIONS, "ec2:DetachNetworkInterface"],
        resources: ["*"],
        conditions: {
          ArnLike: { "lambda:SourceFunctionArn": functionArns },
        },
      }),
    ],
    acknowledgements,
  };
}
