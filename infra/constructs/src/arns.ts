// ARNs of resources named in policies, by name, in the scope's stack's partition. Each takes its
// account, and its region where the resource has one, from the stack unless given.

import { ArnFormat, Stack } from "aws-cdk-lib";
import type { IConstruct } from "constructs";

/** A role's ARN. Roles have no region. `name` may be a pattern such as `app-dev-*`. */
export function roleArn(
  scope: IConstruct,
  name: string,
  account?: string,
): string {
  return Stack.of(scope).formatArn({
    service: "iam",
    region: "",
    ...(account !== undefined && { account }),
    resource: "role",
    resourceName: name,
  });
}

/** A function's ARN, or a pattern of them, or an alias's as `<name>:<alias>`. */
export function functionArn(
  scope: IConstruct,
  name: string,
  account?: string,
): string {
  return Stack.of(scope).formatArn({
    service: "lambda",
    ...(account !== undefined && { account }),
    resource: "function",
    resourceName: name,
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });
}

/** A log group's ARN. Its streams are `${arn}:*`. */
export function logGroupArn(scope: IConstruct, name: string): string {
  return Stack.of(scope).formatArn({
    service: "logs",
    resource: "log-group",
    resourceName: name,
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });
}

/** A DynamoDB table's ARN. */
export function tableArn(
  scope: IConstruct,
  name: string,
  region?: string,
): string {
  return Stack.of(scope).formatArn({
    service: "dynamodb",
    ...(region !== undefined && { region }),
    resource: "table",
    resourceName: name,
  });
}
