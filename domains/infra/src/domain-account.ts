import { PlatformLogGroup } from "@repo/infra-constructs";
import { ArnFormat, Stack, Validations } from "aws-cdk-lib";
import { CfnAccount } from "aws-cdk-lib/aws-apigateway";
import {
  Certificate,
  CertificateValidation,
} from "aws-cdk-lib/aws-certificatemanager";
import { CfnSecurityGroup } from "aws-cdk-lib/aws-ec2";
import {
  Effect,
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  CaaAmazonRecord,
  HostedZone,
  type HostedZoneAttributes,
} from "aws-cdk-lib/aws-route53";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

import {
  apiAccessLogGroupName,
  apiExecutionLogGroupName,
  certificateParameterName,
  DOMAIN_REGION,
  domainFunctionName,
  executionRoleName,
  functionLogGroupName,
  integrationRoleName,
  lambdaEndpointSecurityGroupParameterName,
  LIVE_ALIAS,
  securityGroupParameterName,
  vpcIdParameterName,
} from "./names.ts";

// Lambda creates a function's network interfaces in its subnets as the function's role.
const NETWORK_INTERFACE_ACTIONS = [
  "ec2:AssignPrivateIpAddresses",
  "ec2:CreateNetworkInterface",
  "ec2:DeleteNetworkInterface",
  "ec2:DescribeNetworkInterfaces",
  "ec2:DescribeSubnets",
  "ec2:UnassignPrivateIpAddresses",
];

export interface DomainAccountProps {
  readonly environment: string;
  readonly zone: HostedZoneAttributes;
  /** A name pattern, such as `gateway-<environment>-*`. */
  readonly gatewayFunctions: string;
}

/**
 * What every domain in a domain account shares in one environment. Nothing in it names a domain:
 * the roles reach the domains' resources by name pattern, so adding or removing a domain never
 * changes it.
 */
export class DomainAccount extends Construct {
  constructor(scope: Construct, id: string, props: DomainAccountProps) {
    super(scope, id);

    const stack = Stack.of(this);

    if (stack.region !== DOMAIN_REGION) {
      throw new Error(
        `A domain account's resources must be created in ${DOMAIN_REGION}, the region the edge signs requests for, not ${stack.region}`,
      );
    }

    this.createCertificate(props);
    this.createSecurityGroup(props);

    const functionLogGroup = new PlatformLogGroup(this, "FunctionLogs", {
      logGroupName: functionLogGroupName(props.environment),
    });

    this.createIntegrationRole(props);
    this.createExecutionRole(props, functionLogGroup);

    this.setApiGatewayLogging(props);
  }

  // One wildcard for every domain: a certificate for `<domain>.<zone>` would leave a domain's name
  // as few as 18 of ACM's 64 characters.
  private createCertificate({
    environment,
    zone: attributes,
  }: DomainAccountProps): void {
    const zone = HostedZone.fromHostedZoneAttributes(this, "Zone", attributes);

    const caa = new CaaAmazonRecord(this, "Caa", {
      zone,
      recordName: attributes.zoneName,
    });

    const certificate = new Certificate(this, "Certificate", {
      domainName: `*.${attributes.zoneName}`,
      validation: CertificateValidation.fromDns(zone),
    });

    // ACM checks CAA before it issues.
    certificate.node.addDependency(caa);

    new StringParameter(this, "CertificateArn", {
      parameterName: certificateParameterName(environment),
      stringValue: certificate.certificateArn,
    });
  }

  // Created in a VPC that isn't ours. A domain may reach only the VPC's Lambda endpoint, to invoke
  // gateways. The endpoint's own group must let it in.
  private createSecurityGroup({ environment }: DomainAccountProps): void {
    const securityGroup = new CfnSecurityGroup(this, "SecurityGroup", {
      groupDescription: `Domain functions in ${environment}`,
      vpcId: StringParameter.valueForStringParameter(
        this,
        vpcIdParameterName(environment),
      ),
      securityGroupEgress: [
        {
          description: "Invoke gateways through the VPC's Lambda endpoint",
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          destinationSecurityGroupId: StringParameter.valueForStringParameter(
            this,
            lambdaEndpointSecurityGroupParameterName(environment),
          ),
        },
      ],
    });

    new StringParameter(this, "SecurityGroupId", {
      parameterName: securityGroupParameterName(environment),
      stringValue: securityGroup.attrGroupId,
    });
  }

  // API Gateway invokes every domain's function through this one role, so no domain's function
  // needs a resource policy, and one created again under the same name needs nothing added.
  private createIntegrationRole({ environment }: DomainAccountProps): void {
    const stack = Stack.of(this);

    const liveFunctions = stack.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: `${domainFunctionName(environment, "*")}:${LIVE_ALIAS}`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    const role = new Role(this, "IntegrationRole", {
      roleName: integrationRoleName(environment),
      assumedBy: new ServicePrincipal("apigateway.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": stack.account } },
      }),
      inlinePolicies: {
        Invoke: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["lambda:InvokeFunction"],
              resources: [liveFunctions],
            }),
          ],
        }),
      },
    });

    Validations.of(role).acknowledge({
      id: `AwsSolutions-IAM5[Resource::${liveFunctions}]`,
      reason:
        "Each domain's function is created outside CloudFormation under this pattern, so the role names the pattern. It reaches only the released alias.",
    });
  }

  // Every domain has the same permissions, so they run as one role. The boundary holds the same
  // limits, in case the role is ever widened by mistake.
  private createExecutionRole(
    { environment, gatewayFunctions }: DomainAccountProps,
    logGroup: PlatformLogGroup,
  ): void {
    const stack = Stack.of(this);

    const gateways = stack.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: gatewayFunctions,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    const logs = logGroupArn(stack, functionLogGroupName(environment));

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
        resources: [`${logs}:*`],
      }),
      // A log group encrypted with a customer managed key takes the key to write to, through
      // CloudWatch Logs, for this log group alone.
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["kms:Encrypt", "kms:GenerateDataKey*"],
        resources: [logGroup.key.keyArn],
        conditions: {
          StringEquals: {
            "kms:ViaService": `logs.${stack.region}.amazonaws.com`,
          },
          ArnEquals: { "kms:EncryptionContext:aws:logs:arn": logs },
        },
      }),
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: NETWORK_INTERFACE_ACTIONS,
        resources: ["*"],
      }),
    ];

    const boundary = new ManagedPolicy(this, "ExecutionBoundary", {
      description: `The most any domain's function may do in ${environment}`,
      statements,
    });

    const role = new Role(this, "ExecutionRole", {
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
          id: `AwsSolutions-IAM5[Resource::${logs}:*]`,
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
            "Only Lambda's network interface actions take *: their Describe actions support no resource ARN. The role's statements are tested exactly, so no other * can be added unseen.",
        },
      );
    }
  }

  // API Gateway has one logging role per account and region, which every API in it writes as.
  // It creates no log group: each domain's stack creates its own first, encrypted.
  private setApiGatewayLogging({ environment }: DomainAccountProps): void {
    const stack = Stack.of(this);

    const accessLogs = logGroupArn(
      stack,
      apiAccessLogGroupName(environment, "*"),
    );
    const executionLogs = logGroupArn(
      stack,
      apiExecutionLogGroupName("*", "*"),
    );
    const anyKey = stack.formatArn({
      service: "kms",
      resource: "key",
      resourceName: "*",
    });

    const role = new Role(this, "ApiGatewayLogsRole", {
      assumedBy: new ServicePrincipal("apigateway.amazonaws.com"),
      inlinePolicies: {
        WriteLogs: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: [
                "logs:CreateLogStream",
                "logs:DescribeLogStreams",
                "logs:PutLogEvents",
              ],
              resources: [`${accessLogs}:*`, `${executionLogs}:*`],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["logs:DescribeLogGroups"],
              resources: ["*"],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["kms:Encrypt", "kms:GenerateDataKey*"],
              resources: [anyKey],
              conditions: {
                StringEquals: {
                  "kms:ViaService": `logs.${stack.region}.amazonaws.com`,
                },
                ArnLike: {
                  "kms:EncryptionContext:aws:logs:arn": [
                    accessLogs,
                    executionLogs,
                  ],
                },
              },
            }),
          ],
        }),
      },
    });

    Validations.of(role).acknowledge(
      {
        id: `AwsSolutions-IAM5[Resource::${accessLogs}:*]`,
        reason:
          "Each domain's API logs to a group named under this pattern, and API Gateway names each stream.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${executionLogs}:*]`,
        reason:
          "API Gateway names each API's execution log group after the API's generated ID.",
      },
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason: "DescribeLogGroups applies to no log group ARN.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${anyKey}]`,
        reason:
          "Each domain's stack has its own generated key. The grant holds only through CloudWatch Logs, for the domains' API log groups.",
      },
      {
        id: "AwsSolutions-IAM5[Action::kms:GenerateDataKey*]",
        reason: "CloudWatch Logs chooses which GenerateDataKey call it makes.",
      },
    );

    new CfnAccount(this, "ApiGatewayAccount", {
      cloudWatchRoleArn: role.roleArn,
    });
  }
}

function logGroupArn(stack: Stack, logGroupName: string): string {
  return stack.formatArn({
    service: "logs",
    resource: "log-group",
    resourceName: logGroupName,
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });
}
