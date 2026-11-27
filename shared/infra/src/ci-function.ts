import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  cloudFrontFunctionUrl,
  logGroupWriteStatements,
  PlatformLogGroup,
} from "@repo/infra-constructs";
import {
  buildCiFunction,
  type CiDomain,
  type CiEnvironment,
  HANDLER,
} from "@repo/shared-ci";
import { bundleKey } from "@repo/shared-release/bundle-key";
import { Duration, Stack, Validations } from "aws-cdk-lib";
import {
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

import { ARTEFACT_RECORDER_ACTIONS } from "./artefact-table.ts";
import {
  CI_FUNCTION_NAME,
  CI_LOG_GROUP_NAME,
  ciAudience,
  PIPELINE_TOKEN_ISSUER,
  PIPELINE_TOKEN_KEYS_URI,
  SHARED_REGION,
} from "./names.ts";
import { RELEASE_RECORDER_ACTIONS } from "./release-table.ts";

/**
 * How many requests the function serves at once. Lambda answers 429 to one more, which a pipeline
 * tries again.
 */
export const CI_CONCURRENCY = 20;

/**
 * Lambda gives a function CPU in proportion to its memory, and one whole vCPU at this much. Node
 * runs the handler on one thread, so more would buy nothing, and less would slow verifying a
 * token's signature.
 */
export const CI_MEMORY_MB = 1769;

export interface CiFunctionProps {
  /** The shared account's zone, whose apex the pipeline API answers at. */
  readonly zoneName: string;
  /** Each environment of the stage, whether pipelines upload there, and the domains it hosts. */
  readonly environments: readonly CiEnvironment[];
  /** Each of the stage's domains that has a repository, and GitHub's IDs for it. */
  readonly domains: readonly CiDomain[];
  /** The bucket uploads go to, in this stack's account and region. */
  readonly codeBucketName: string;
  /** The queue a release is put on, by the address the function is built with and by ARN. */
  readonly releaseQueue: { readonly url: string; readonly arn: string };
  /** The table each release is recorded in, by the name the function is built with and by ARN. */
  readonly releaseTable: { readonly name: string; readonly arn: string };
  /** The table each uploaded version is recorded in, by name and by ARN, as above. */
  readonly artefactTable: { readonly name: string; readonly arn: string };
}

/**
 * The pipeline API's function, and the URL CloudFront reaches it at. The function is built with
 * who may release what: the token's issuer and audience, and each domain's repository.
 *
 * Its role may write a bundle's key in the code bucket: it signs each upload a pipeline makes, and
 * a signature carries no more than the signer's own permission. It may record each version a
 * pipeline uploads and read one back, look for a bundle, to release only one that was uploaded,
 * put a release on the release worker's queue, and read how a release went.
 *
 * The URL admits CloudFront alone from outside the account (see `cloudFrontFunctionUrl`). The
 * function relies on the token it verifies, never on where a request came from.
 */
export class CiFunction extends Construct {
  public readonly function: LambdaFunction;
  /** The role the function runs as, and so signs uploads as. */
  public readonly role: Role;
  /** The function URL's host, which AWS generates. */
  public readonly urlHost: string;

  constructor(scope: Construct, id: string, props: CiFunctionProps) {
    super(scope, id);

    const stack = Stack.of(this);
    if (stack.region !== SHARED_REGION) {
      throw new Error(
        `The pipeline API's function runs in ${SHARED_REGION}, not ${stack.region}`,
      );
    }

    const { logGroup, key: logGroupKey } = new PlatformLogGroup(this, "Logs", {
      logGroupName: CI_LOG_GROUP_NAME,
    });
    const logs = logGroupWriteStatements(this, {
      logGroupName: CI_LOG_GROUP_NAME,
      logGroupKey,
    });

    // Every key a bundle can have: any domain's, any hash. The function signs only the key of
    // the domain a pipeline is allowed for.
    const bundles = stack.formatArn({
      service: "s3",
      region: "",
      account: "",
      resource: props.codeBucketName,
      resourceName: bundleKey("*", "*"),
    });
    const bucket = stack.formatArn({
      service: "s3",
      region: "",
      account: "",
      resource: props.codeBucketName,
    });
    const role = new Role(this, "Role", {
      roleName: CI_FUNCTION_NAME,
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        Ci: new PolicyDocument({
          statements: [
            ...logs.statements,
            // PutObject, to sign each upload. GetObject for HeadObject, which S3 authorises as a
            // read, to find the version of a bundle to release. An upload's signature covers its
            // method, so no address the function signs reads a bundle.
            new PolicyStatement({
              actions: ["s3:GetObject", "s3:PutObject"],
              resources: [bundles],
            }),
            // Without it, S3 refuses to say an object is missing, rather than saying so.
            new PolicyStatement({
              actions: ["s3:ListBucket"],
              resources: [bucket],
            }),
            new PolicyStatement({
              actions: ["sqs:SendMessage"],
              resources: [props.releaseQueue.arn],
            }),
            // To claim each version for its bundle, and to find the bundle a release names. A
            // version is never changed, so only put and get.
            new PolicyStatement({
              actions: ARTEFACT_RECORDER_ACTIONS,
              resources: [props.artefactTable.arn],
            }),
            // To record each release, to record one the queue wouldn't take as refused, and to
            // answer how one went.
            new PolicyStatement({
              actions: RELEASE_RECORDER_ACTIONS,
              resources: [props.releaseTable.arn],
            }),
          ],
        }),
      },
    });
    this.role = role;
    Validations.of(role).acknowledge(...logs.acknowledgements, {
      id: `AwsSolutions-IAM5[Resource::${bundles}]`,
      reason:
        "A bundle's key holds its domain and its hash, which no stack knows. The grant is held to keys of that shape, and the function signs one only for the domain a pipeline is allowed for.",
    });

    this.function = new LambdaFunction(this, "Function", {
      functionName: CI_FUNCTION_NAME,
      runtime: Runtime.NODEJS_26_X,
      architecture: Architecture.ARM_64,
      handler: HANDLER,
      code: Code.fromAsset(
        bundleDirectory({
          issuer: PIPELINE_TOKEN_ISSUER,
          keysUri: PIPELINE_TOKEN_KEYS_URI,
          audience: ciAudience(props.zoneName),
          environments: props.environments,
          domains: props.domains,
          uploads: {
            bucket: props.codeBucketName,
            region: stack.region,
            table: props.artefactTable.name,
          },
          releases: {
            queueUrl: props.releaseQueue.url,
            table: props.releaseTable.name,
          },
        }),
      ),
      role,
      timeout: Duration.seconds(10),
      memorySize: CI_MEMORY_MB,
      reservedConcurrentExecutions: CI_CONCURRENCY,
      logGroup,
    });

    this.urlHost = cloudFrontFunctionUrl(this.function);
  }
}

// The bundle is per stage, so it's built at synth, into a directory of its own for CDK to stage.
function bundleDirectory(
  config: Parameters<typeof buildCiFunction>[0],
): string {
  const directory = mkdtempSync(path.join(tmpdir(), "pipeline-api-"));
  writeFileSync(path.join(directory, "index.js"), buildCiFunction(config));
  return directory;
}
