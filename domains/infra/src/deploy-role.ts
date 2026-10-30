import { ArnFormat, Stack, Validations } from "aws-cdk-lib";
import {
  AccountRootPrincipal,
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
} from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

import {
  deployRoleName,
  domainFunctionName,
  executionRoleName,
} from "./names.ts";

export interface DeployRoleProps {
  readonly environment: string;
  readonly gatewayFunctions: string;
  readonly subnetIds: readonly string[];
  readonly securityGroupId: string;
}

/**
 * The role a release assumes to create, configure and release a domain's function. It may touch
 * only domain functions, never a gateway, and pass only the execution role. Every function it
 * creates or configures must be in the subnets and security group named: a deny holds whatever else
 * the role is ever allowed.
 */
export class DeployRole extends Construct {
  constructor(
    scope: Construct,
    id: string,
    {
      environment,
      gatewayFunctions,
      subnetIds,
      securityGroupId,
    }: DeployRoleProps,
  ) {
    super(scope, id);

    const stack = Stack.of(this);

    const domainFunctions = stack.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: domainFunctionName(environment, "*"),
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    const gateways = stack.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: gatewayFunctions,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    const executionRole = stack.formatArn({
      service: "iam",
      region: "",
      resource: "role",
      resourceName: executionRoleName(environment),
    });

    const placed = [
      "lambda:CreateFunction",
      "lambda:UpdateFunctionConfiguration",
    ];

    const statements = [
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "lambda:CreateAlias",
          "lambda:CreateFunction",
          "lambda:GetAlias",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:PublishVersion",
          "lambda:UpdateAlias",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
        ],
        resources: [domainFunctions],
      }),
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSubnets",
          "ec2:DescribeVpcs",
          "ec2:GetSecurityGroupsForVpc",
        ],
        resources: ["*"],
      }),
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["iam:PassRole"],
        resources: [executionRole],
        conditions: {
          StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" },
        },
      }),
      new PolicyStatement({
        effect: Effect.DENY,
        actions: ["lambda:*"],
        resources: [gateways],
      }),
      // A function with no VPC has no subnets or security groups, so the denies after this one
      // wouldn't apply to it.
      new PolicyStatement({
        effect: Effect.DENY,
        actions: placed,
        resources: [domainFunctions],
        conditions: { Null: { "lambda:VpcIds": "true" } },
      }),
      new PolicyStatement({
        effect: Effect.DENY,
        actions: placed,
        resources: [domainFunctions],
        conditions: {
          "ForAnyValue:StringNotEquals": { "lambda:SubnetIds": subnetIds },
        },
      }),
      new PolicyStatement({
        effect: Effect.DENY,
        actions: placed,
        resources: [domainFunctions],
        conditions: {
          "ForAnyValue:StringNotEquals": {
            "lambda:SecurityGroupIds": [securityGroupId],
          },
        },
      }),
    ];

    const role = new Role(this, "Role", {
      roleName: deployRoleName(environment),
      assumedBy: new AccountRootPrincipal(),
      inlinePolicies: {
        Deploy: new PolicyDocument({ statements }),
      },
    });

    Validations.of(role).acknowledge(
      {
        id: `AwsSolutions-IAM5[Resource::${domainFunctions}]`,
        reason:
          "Each domain's function is created outside CloudFormation under this pattern, by whatever assumes this role.",
      },
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "Lambda checks a function's VPC, subnets and security groups as the caller, and these EC2 Describe actions support no resource ARN.",
      },
    );
  }
}
