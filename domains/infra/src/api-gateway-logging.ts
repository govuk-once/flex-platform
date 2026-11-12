import { ArnFormat, Stack, Validations } from "aws-cdk-lib";
import { CfnAccount } from "aws-cdk-lib/aws-apigateway";
import {
  Effect,
  ManagedPolicy,
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

const PUSH_TO_CLOUDWATCH_LOGS =
  "service-role/AmazonAPIGatewayPushToCloudWatchLogs";

/**
 * The role API Gateway writes every API's access and execution logs as, set on the account. API
 * Gateway has one per account and region.
 *
 * API Gateway refuses a role that may not create, describe, write to and read any log group: it
 * checks the role's effective permissions, so neither scoping them nor denying one is accepted. So
 * it has AWS's managed policy, and each API's stack creates its log groups before its stage.
 */
export class ApiGatewayLogging extends Construct {
  constructor(
    scope: Construct,
    id: string,
    { environment }: ApiGatewayLoggingProps,
  ) {
    super(scope, id);

    const stack = Stack.of(this);

    const logGroupArn = (resourceName: string) =>
      stack.formatArn({
        service: "logs",
        resource: "log-group",
        resourceName,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      });

    const anyKey = stack.formatArn({
      service: "kms",
      resource: "key",
      resourceName: "*",
    });

    const role = new Role(this, "Role", {
      assumedBy: new ServicePrincipal("apigateway.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(PUSH_TO_CLOUDWATCH_LOGS),
      ],
      inlinePolicies: {
        EncryptLogs: new PolicyDocument({
          statements: [
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
                    logGroupArn(apiAccessLogGroupName(environment, "*")),
                    logGroupArn(apiExecutionLogGroupName("*", "*")),
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
        id: `AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/${PUSH_TO_CLOUDWATCH_LOGS}]`,
        reason:
          "API Gateway refuses a logging role that may not create, write to and read any log group, and counts a deny against it.",
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
