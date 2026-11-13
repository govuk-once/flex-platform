import { Stack } from "aws-cdk-lib";
import type { IDistribution } from "aws-cdk-lib/aws-cloudfront";
import { Effect, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  CfnDelivery,
  CfnDeliveryDestination,
  CfnDeliverySource,
  CfnResourcePolicy,
  type LogGroup,
} from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

import { PlatformLogGroup } from "../log-group.ts";

export interface AccessLogsProps {
  /**
   * The delivery's names: its source, its destination and the account's resource policy that
   * lets it write. CloudFormation names the log group the logs are delivered to.
   */
  readonly name: string;
  readonly distribution: IDistribution;
}

/**
 * Delivers a distribution's standard access logs to a log group, which it returns, by standard
 * logging v2. Log forwarding will carry the group on to the shared account. CloudFront's delivery
 * source must be in us-east-1, as a web ACL must.
 *
 * It builds in the scope it is given, under IDs that start with `AccessLog`, and not in a
 * construct of its own: a distribution's construct holds these beside the distribution, and their
 * IDs are a contract.
 */
export function deliverAccessLogs(
  scope: Construct,
  { name, distribution }: AccessLogsProps,
): LogGroup {
  const stack = Stack.of(scope);
  const { logGroup } = new PlatformLogGroup(scope, "AccessLogs");

  const source = new CfnDeliverySource(scope, "AccessLogSource", {
    name,
    logType: "ACCESS_LOGS",
    resourceArn: distribution.distributionArn,
  });

  // The delivery service writes to the log group under its own principal, which the account
  // has to allow; the conditions tie the grant to this one source.
  const policy = new CfnResourcePolicy(scope, "AccessLogPolicy", {
    policyName: name,
    policyDocument: stack.toJsonString({
      Version: "2012-10-17",
      Statement: [
        new PolicyStatement({
          sid: "AllowLogDelivery",
          effect: Effect.ALLOW,
          principals: [new ServicePrincipal("delivery.logs.amazonaws.com")],
          actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [logGroup.logGroupArn],
          conditions: {
            StringEquals: { "aws:SourceAccount": stack.account },
            ArnLike: {
              "aws:SourceArn": stack.formatArn({
                service: "logs",
                resource: "delivery-source",
                resourceName: name,
              }),
            },
          },
        }).toStatementJson(),
      ],
    }),
  });

  const destination = new CfnDeliveryDestination(
    scope,
    "AccessLogDestination",
    {
      name,
      deliveryDestinationType: "CWL",
      destinationResourceArn: logGroup.logGroupArn,
    },
  );

  const delivery = new CfnDelivery(scope, "AccessLogDelivery", {
    deliverySourceName: source.name,
    deliveryDestinationArn: destination.attrArn,
  });
  delivery.addResourceDependency(source);
  delivery.addResourceDependency(policy);

  return logGroup;
}
