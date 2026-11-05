import { ArnFormat, Stack, Validations } from "aws-cdk-lib";
import {
  AccountRootPrincipal,
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
} from "aws-cdk-lib/aws-iam";
import { StringListParameter, StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

import {
  deployRoleName,
  domainFunctionName,
  executionRoleName,
} from "./names.ts";

export interface DeployRoleProps {
  readonly environment: string;
  readonly domain: string;
  readonly gatewayFunctions: string;
  /** The SSM parameter holding the subnets every function must be in, as a list. */
  readonly subnetIdsParameterName: string;
  /** The SSM parameter holding the security group every function must have. */
  readonly securityGroupIdParameterName: string;
}

/**
 * The role a release assumes to create, configure and release one domain's function. It may touch
 * only that function, never a gateway, and pass only that domain's execution role, so no release
 * can give a function another domain's role. Every function it creates or configures must be in
 * the subnets and security group the parameters hold: a deny holds whatever else the role is ever
 * allowed. A release reads the same parameters as the role, so it places a function as the denies
 * require.
 */
export class DeployRole extends Construct {
  constructor(
    scope: Construct,
    id: string,
    {
      environment,
      domain,
      gatewayFunctions,
      subnetIdsParameterName,
      securityGroupIdParameterName,
    }: DeployRoleProps,
  ) {
    super(scope, id);

    const stack = Stack.of(this);

    const domainFunction = stack.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: domainFunctionName(environment, domain),
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    // The function, and its versions and aliases, such as `:live`. A function's name holds no
    // colon, so no other function's ARN matches.
    const domainFunctions = [domainFunction, `${domainFunction}:*`];

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
      resourceName: executionRoleName(environment, domain),
    });

    const subnetIds = StringListParameter.valueForTypedListParameter(
      this,
      subnetIdsParameterName,
    );
    const securityGroupId = StringParameter.valueForStringParameter(
      this,
      securityGroupIdParameterName,
    );

    // A parameter's name starts with a slash, which its ARN holds once.
    const placementParameters = [
      subnetIdsParameterName,
      securityGroupIdParameterName,
    ].map((name) =>
      stack.formatArn({
        service: "ssm",
        resource: "parameter",
        resourceName: name.replace(/^\//, ""),
      }),
    );

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
        resources: domainFunctions,
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
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: placementParameters,
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
        resources: domainFunctions,
        conditions: { Null: { "lambda:VpcIds": "true" } },
      }),
      new PolicyStatement({
        effect: Effect.DENY,
        actions: placed,
        resources: domainFunctions,
        conditions: {
          "ForAnyValue:StringNotEquals": { "lambda:SubnetIds": subnetIds },
        },
      }),
      new PolicyStatement({
        effect: Effect.DENY,
        actions: placed,
        resources: domainFunctions,
        conditions: {
          "ForAnyValue:StringNotEquals": {
            "lambda:SecurityGroupIds": [securityGroupId],
          },
        },
      }),
    ];

    const role = new Role(this, "Role", {
      roleName: deployRoleName(environment, domain),
      assumedBy: new AccountRootPrincipal(),
      inlinePolicies: {
        Deploy: new PolicyDocument({ statements }),
      },
    });

    Validations.of(role).acknowledge(
      {
        id: `AwsSolutions-IAM5[Resource::${domainFunction}:*]`,
        reason:
          "A release publishes versions and moves the live alias, which are named after the function's own ARN.",
      },
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "Lambda checks a function's VPC, subnets and security groups as the caller, and these EC2 Describe actions support no resource ARN.",
      },
    );
  }
}
