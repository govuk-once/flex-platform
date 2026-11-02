import { ArnFormat, Stack, Validations } from "aws-cdk-lib";
import {
  Effect,
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import type { IKey } from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

import {
  domainFunctionName,
  executionRoleName,
  functionLogGroupName,
} from "./names.ts";

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

export interface ExecutionRoleProps {
  readonly environment: string;
  /** The functions a domain may invoke, as a name pattern such as `gateway-dev-*`. */
  readonly gatewayFunctions: string;
  /** The key the function log group is encrypted with. */
  readonly logGroupKey: IKey;
}

/**
 * The role every domain's function in the environment runs as. Every domain has the same
 * permissions, so they share it. Its boundary holds the same limits, in case the role is ever
 * widened by mistake.
 */
export class ExecutionRole extends Construct {
  constructor(
    scope: Construct,
    id: string,
    { environment, gatewayFunctions, logGroupKey }: ExecutionRoleProps,
  ) {
    super(scope, id);

    const stack = Stack.of(this);

    const gateways = stack.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: gatewayFunctions,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    const domainFunctions = stack.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: domainFunctionName(environment, "*"),
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    const logGroupArn = stack.formatArn({
      service: "logs",
      resource: "log-group",
      resourceName: functionLogGroupName(environment),
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    const logStreams = `${logGroupArn}:*`;

    const statements = [
      // The pattern covers each gateway's qualifiers too, such as `:live`.
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: [gateways],
      }),
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
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: NETWORK_INTERFACE_ACTIONS,
        resources: ["*"],
      }),
      // Lambda sends a function's traces as its role when tracing is active.
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["xray:PutTelemetryRecords", "xray:PutTraceSegments"],
        resources: ["*"],
      }),
      // The function's code holds the role's credentials too. Lambda's own calls to manage its
      // network interfaces carry no source function, so this denies only the code's.
      new PolicyStatement({
        effect: Effect.DENY,
        actions: [...NETWORK_INTERFACE_ACTIONS, "ec2:DetachNetworkInterface"],
        resources: ["*"],
        conditions: {
          ArnLike: { "lambda:SourceFunctionArn": domainFunctions },
        },
      }),
    ];

    const boundary = new ManagedPolicy(this, "Boundary", {
      description: `The most any domain's function may do in ${environment}`,
      statements,
    });

    const role = new Role(this, "Role", {
      roleName: executionRoleName(environment),
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      permissionsBoundary: boundary,
      inlinePolicies: {
        Execution: new PolicyDocument({ statements }),
      },
    });

    for (const scope of [role, boundary]) {
      Validations.of(scope).acknowledge(
        {
          id: `AwsSolutions-IAM5[Resource::${gateways}]`,
          reason:
            "Every domain may invoke every gateway in its environment, by requirement. Gateways are named by this pattern, and only gateways have it.",
        },
        {
          id: `AwsSolutions-IAM5[Resource::${logStreams}]`,
          reason:
            "Lambda names each log stream itself, so the grant covers every stream in the one log group.",
        },
        {
          id: "AwsSolutions-IAM5[Action::kms:GenerateDataKey*]",
          reason:
            "CloudWatch Logs chooses which GenerateDataKey call it makes; the grant holds only for the one key and log group.",
        },
        {
          id: "AwsSolutions-IAM5[Resource::*]",
          reason:
            "Only Lambda's network interface actions, which AWS requires on *, and X-Ray's, which support no resource ARN, take it. The role's statements are tested exactly, so no other * can be added unseen.",
        },
      );
    }
  }
}
