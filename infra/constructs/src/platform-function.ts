import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { type Acknowledgment, type Duration, Validations } from "aws-cdk-lib";
import {
  PolicyDocument,
  type PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import type { ILogGroup } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

import { logGroupWriteStatements } from "./function-role.ts";
import { PlatformLogGroup } from "./log-group.ts";

/**
 * A bundle built at synth, such as one with a stage's config baked in, as `index.js` in a
 * directory of its own for CDK to stage. Its handler is `index.handler`.
 */
export function bundledCode(code: string): Code {
  const directory = mkdtempSync(path.join(tmpdir(), "platform-function-"));
  writeFileSync(path.join(directory, "index.js"), code);
  return Code.fromAsset(directory);
}

export interface PlatformFunctionProps {
  readonly functionName: string;
  readonly roleName: string;
  readonly logGroupName: string;
  /** The role's inline policy, by its name, beside writing to the function's log group. */
  readonly policyName: string;
  readonly statements: readonly PolicyStatement[];
  /** cdk-nag's findings on the statements' wildcards, acknowledged with the reason for each. */
  readonly acknowledgements?: readonly Acknowledgment[];
  /** The bundle, as `bundledCode` takes it. */
  readonly code: string;
  readonly timeout: Duration;
  readonly memorySize: number;
  readonly reservedConcurrentExecutions?: number;
}

export interface PlatformFunction {
  readonly function: LambdaFunction;
  readonly role: Role;
  readonly logGroup: ILogGroup;
}

/**
 * A function outside a VPC, with a role of its own that may write to its own log group and do
 * what the statements say. Built in `scope`, as `Logs`, `Role` and `Function`, rather than as a
 * construct of its own, so a construct that had built them itself keeps their IDs.
 */
export function platformFunction(
  scope: Construct,
  props: PlatformFunctionProps,
): PlatformFunction {
  const { logGroupName } = props;
  const { logGroup, key: logGroupKey } = new PlatformLogGroup(scope, "Logs", {
    logGroupName,
  });
  const logs = logGroupWriteStatements(scope, { logGroupName, logGroupKey });

  const role = new Role(scope, "Role", {
    roleName: props.roleName,
    assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    inlinePolicies: {
      [props.policyName]: new PolicyDocument({
        statements: [...logs.statements, ...props.statements],
      }),
    },
  });
  Validations.of(role).acknowledge(
    ...logs.acknowledgements,
    ...(props.acknowledgements ?? []),
  );

  const fn = new LambdaFunction(scope, "Function", {
    functionName: props.functionName,
    runtime: Runtime.NODEJS_26_X,
    architecture: Architecture.ARM_64,
    handler: "index.handler",
    code: bundledCode(props.code),
    role,
    timeout: props.timeout,
    memorySize: props.memorySize,
    ...(props.reservedConcurrentExecutions !== undefined && {
      reservedConcurrentExecutions: props.reservedConcurrentExecutions,
    }),
    logGroup,
  });
  return { function: fn, role, logGroup };
}
