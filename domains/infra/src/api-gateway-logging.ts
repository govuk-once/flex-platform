import { ArnFormat, Stack, Validations } from "aws-cdk-lib";
import { CfnAccount } from "aws-cdk-lib/aws-apigateway";
import {
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

import { apiAccessLogGroupName, apiExecutionLogGroupName } from "./names.ts";

export interface ApiGatewayLoggingProps {
  readonly environment: string;
}

/**
 * The role API Gateway writes every API's access and execution logs as, set on the account. API
 * Gateway has one per account and region. The role may create no log group, so it writes only to
 * groups that already exist, encrypted.
 */
export class ApiGatewayLogging extends Construct {
  constructor(
    scope: Construct,
    id: string,
    { environment }: ApiGatewayLoggingProps,
  ) {
    super(scope, id);

    const stack = Stack.of(this);

    const accessLogs = stack.formatArn({
      service: "logs",
      resource: "log-group",
      resourceName: apiAccessLogGroupName(environment, "*"),
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    const executionLogs = stack.formatArn({
      service: "logs",
      resource: "log-group",
      resourceName: apiExecutionLogGroupName("*", "*"),
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    const anyKey = stack.formatArn({
      service: "kms",
      resource: "key",
      resourceName: "*",
    });

    const role = new Role(this, "Role", {
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

    new CfnAccount(this, "Account", { cloudWatchRoleArn: role.roleArn });
  }
}
