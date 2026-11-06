import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";

import { GATEWAY_FUNCTION_ALIAS } from "@repo/gateway-core";
import { PlatformLogGroup } from "@repo/infra-constructs";
import { ArnFormat, Duration, Stack, Validations } from "aws-cdk-lib";
import {
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  Alias,
  Architecture,
  type CfnFunction,
  Code,
  Function,
  type IVersion,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { StringListParameter, StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

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

// A domain answers within API Gateway's 29 seconds, so no gateway call it makes can be given
// longer. The client's own deadline is what normally ends a call first.
const TIMEOUT = Duration.seconds(28);

const MEMORY_MB = 1024;

export interface GatewayFunctionProps {
  readonly functionName: string;
  readonly roleName: string;
  readonly logGroupName: string;
  /** The bundle codegen writes, `.gen/runtime/bundle.mjs` in the gateway's package. */
  readonly bundle: string;
  readonly environment: Readonly<Record<string, string>>;
  /** What the function may do beyond writing its logs and running in its subnets. */
  readonly statements: readonly PolicyStatement[];
  /** Its placement's subnets, by the parameter the network writes their IDs to. */
  readonly subnetIdsParameterName: string;
  /** Its placement's security group, by the parameter the network writes its ID to. */
  readonly securityGroupIdParameterName: string;
  /** Every gateway's function, as a name pattern such as `gateway-dev-*`. */
  readonly gatewayFunctions: string;
}

/**
 * A gateway's function, the role it runs as, and its log group. The stack owns the function's code,
 * its version and the alias every client invokes, so a gateway is only ever released by deploying
 * its stack. The alias moves to a version only once the version exists, so no call meets new code
 * with old configuration.
 *
 * The role may write only to its own log group, and the function runs in its placement's subnets
 * and security group, which the network writes to SSM.
 */
export class GatewayFunction extends Construct {
  public readonly function: Function;
  public readonly role: Role;
  public readonly alias: Alias;

  constructor(scope: Construct, id: string, props: GatewayFunctionProps) {
    super(scope, id);

    const stack = Stack.of(this);

    if (!existsSync(props.bundle)) {
      throw new Error(
        `${props.functionName} has no bundle at ${props.bundle}. Run pnpm codegen first.`,
      );
    }

    const { logGroup, key } = new PlatformLogGroup(this, "Logs", {
      logGroupName: props.logGroupName,
    });

    const logGroupArn = stack.formatArn({
      service: "logs",
      resource: "log-group",
      resourceName: props.logGroupName,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    const logStreams = `${logGroupArn}:*`;

    const gatewayFunctions = stack.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: props.gatewayFunctions,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    const statements = [
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
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: NETWORK_INTERFACE_ACTIONS,
        resources: ["*"],
      }),
      // The function's code holds the role's credentials too. Lambda's own calls to manage its
      // network interfaces carry no source function, so this denies only the code's. It names
      // every gateway's function, so it holds even if the role is ever given to another's.
      new PolicyStatement({
        effect: Effect.DENY,
        actions: [...NETWORK_INTERFACE_ACTIONS, "ec2:DetachNetworkInterface"],
        resources: ["*"],
        conditions: {
          ArnLike: { "lambda:SourceFunctionArn": gatewayFunctions },
        },
      }),
      ...props.statements,
    ];

    this.role = new Role(this, "Role", {
      roleName: props.roleName,
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        Execution: new PolicyDocument({ statements }),
      },
    });

    this.function = new Function(this, "Function", {
      functionName: props.functionName,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      // The bundle alone: codegen writes what it was built from beside it.
      code: Code.fromAsset(dirname(props.bundle), {
        exclude: ["*", `!${basename(props.bundle)}`],
      }),
      handler: `${basename(props.bundle).replace(/\.m?js$/, "")}.handler`,
      role: this.role,
      timeout: TIMEOUT,
      memorySize: MEMORY_MB,
      environment: { ...props.environment },
      logGroup,
    });

    // The subnets and group are IDs the network writes to SSM, which CloudFormation resolves at
    // deploy, so there is no VPC to give the function's own `vpc` setting.
    (this.function.node.defaultChild as CfnFunction).vpcConfig = {
      subnetIds: StringListParameter.valueForTypedListParameter(
        this,
        props.subnetIdsParameterName,
      ),
      securityGroupIds: [
        StringParameter.valueForStringParameter(
          this,
          props.securityGroupIdParameterName,
        ),
      ],
    };

    this.alias = new Alias(this, "Live", {
      aliasName: GATEWAY_FUNCTION_ALIAS,
      // CDK declares a version's role optional where IVersion requires it, which only
      // exactOptionalPropertyTypes notices.
      version: this.function.currentVersion as IVersion,
    });

    Validations.of(this.role).acknowledge(
      {
        id: `AwsSolutions-IAM5[Resource::${logStreams}]`,
        reason:
          "Lambda names each log stream itself, so the grant covers every stream in the gateway's own log group.",
      },
      {
        id: "AwsSolutions-IAM5[Action::kms:GenerateDataKey*]",
        reason:
          "CloudWatch Logs chooses which GenerateDataKey call it makes; the grant holds only for the one key and log group.",
      },
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "Only Lambda's network interface actions, which AWS requires on *, take it. The role's statements are tested exactly, so no other * can be added unseen.",
      },
    );
  }
}
