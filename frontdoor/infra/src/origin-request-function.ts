import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildOriginRequestFunction,
  HANDLER,
} from "@repo/frontdoor-origin-request";
import type { TrustedIssuer } from "@repo/frontdoor-shared";
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  CompositePrincipal,
  ManagedPolicy,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  Runtime,
  type Version,
} from "aws-cdk-lib/aws-lambda";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import {
  edgeRoleName,
  ORIGIN_REQUEST_LOG_REGION,
  originRequestFunctionName,
  originRequestLogGroupName,
  originRequestLogsPolicyName,
} from "./names.ts";

/**
 * Lambda gives CPU in proportion to memory, which speeds the cold path (the key fetch, TLS) and
 * the signature check. A full vCPU, at 1,769 MB, is the room left to grow.
 */
export const ORIGIN_REQUEST_MEMORY_MB = 1024;

/** The key fetch's worst case is about 6 seconds; Lambda@Edge allows 30 at origin request. */
export const ORIGIN_REQUEST_TIMEOUT = Duration.seconds(10);

export interface OriginRequestFunctionProps {
  readonly environment: string;
  /** The user pools and app clients whose tokens the function verifies. */
  readonly issuers: readonly TrustedIssuer[];
}

/**
 * The Lambda@Edge function that verifies each request's token, with an environment's issuers
 * baked in, and its role.
 *
 * Each copy logs in the region it ran in, to the group the function names. The role may write
 * only to that group in `ORIGIN_REQUEST_LOG_REGION`, through the policy the group's own stack
 * provides, so no copy creates a log group or writes anywhere else.
 *
 * The function and its versions are retained: Lambda refuses to delete a version until CloudFront
 * has removed its copies, hours after it is detached.
 */
export class OriginRequestFunction extends Construct {
  public readonly function: LambdaFunction;
  /** The numbered version the distribution runs. */
  public readonly version: Version;
  public readonly role: Role;

  constructor(scope: Construct, id: string, props: OriginRequestFunctionProps) {
    super(scope, id);

    const stack = Stack.of(this);
    if (stack.region !== "us-east-1") {
      throw new Error(
        `A Lambda@Edge function must be created in us-east-1, not ${stack.region}`,
      );
    }

    const logGroupName = originRequestLogGroupName(props.environment);
    // Its only permissions: the policy the log group's stack provides, attached by name.
    this.role = new Role(this, "Role", {
      roleName: edgeRoleName(props.environment),
      assumedBy: new CompositePrincipal(
        new ServicePrincipal("lambda.amazonaws.com"),
        new ServicePrincipal("edgelambda.amazonaws.com"),
      ),
      managedPolicies: [
        ManagedPolicy.fromManagedPolicyName(
          this,
          "LogsPolicy",
          originRequestLogsPolicyName(
            props.environment,
            ORIGIN_REQUEST_LOG_REGION,
          ),
        ),
      ],
    });

    this.function = new LambdaFunction(this, "Function", {
      functionName: originRequestFunctionName(props.environment),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.X86_64,
      handler: HANDLER,
      code: Code.fromAsset(bundleDirectory(props.issuers)),
      memorySize: ORIGIN_REQUEST_MEMORY_MB,
      timeout: ORIGIN_REQUEST_TIMEOUT,
      role: this.role,
      // Referenced, never created: the group in us-east-1 doesn't exist.
      logGroup: LogGroup.fromLogGroupName(this, "Logs", logGroupName),
      currentVersionOptions: { removalPolicy: RemovalPolicy.RETAIN },
    });
    this.function.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.version = this.function.currentVersion;
  }
}

// The bundle is per environment, so it's built at synth, into a directory of its own for CDK to
// stage. 45 KB is too large for inline code.
function bundleDirectory(issuers: readonly TrustedIssuer[]): string {
  const directory = mkdtempSync(path.join(tmpdir(), "origin-request-"));
  writeFileSync(
    path.join(directory, "index.js"),
    buildOriginRequestFunction({ issuers }),
  );
  return directory;
}
