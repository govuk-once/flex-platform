// Releases one uploaded bundle to one domain's function: creates the function the first time, or
// else brings its configuration and code up to date, then publishes a function version and points
// `live` at it. The domain's API invokes `live` and nothing else, so nothing reaches the new code until
// the last step.
//
// Lambda is the record of what is deployed, and every step looks at it before it acts. So an
// attempt picks up where the last stopped, and an attempt at what is done changes nothing: a
// release `live` already names is done, the function is created once, a function version with the
// same code and configuration as the last is the one Lambda already has, and `live` moves only
// from the function version it was read at. Two attempts at once are safe too: Lambda refuses a change to a
// function it is still changing, and the one refused is tried again.
//
// `live` records the release that set it and that release's version. It never moves for a release
// of an earlier version, or for one asked for before the release on it. The version holds a
// pipeline to the domain's order. The time a release was asked for is in its ID, and stops a
// release asked for before another landed from running after it: once something other than a
// pipeline release can put an earlier version on `live`, a release asked for before that can't
// undo it. So an old release run again, however it was got, can't roll a domain back.

import { bundleKey } from "../bundle-key.ts";
import { compareBundleVersions } from "../bundle-version.ts";
import { releaseRequestedAt } from "../release-id.ts";
import type { ReleaseRequest } from "../request.ts";
import type { ReleaseTarget } from "./types.ts";

/** The alias the domain's API invokes. */
export const LIVE_ALIAS = "live";

/**
 * What the platform sets for every domain's function. The timeout is API Gateway's: the domain's
 * API waits 29 seconds for the function, so a function never runs on after no one is waiting.
 */
export const FUNCTION_SETTINGS = {
  runtime: "nodejs26.x",
  handler: "index.handler",
  architecture: "arm64",
  memoryMb: 1024,
  timeoutSeconds: 29,
} as const;

/** Each step of a release, as the log names it. */
export type ReleaseStep =
  | "check-bundle"
  | "check-order"
  | "read-network"
  | "read-function"
  | "create-function"
  | "update-configuration"
  | "update-code"
  | "check-code"
  | "publish-version"
  | "move-alias";

/** Everything a release sets on the function. */
export interface FunctionDefinition {
  readonly name: string;
  readonly roleArn: string;
  readonly runtime: typeof FUNCTION_SETTINGS.runtime;
  readonly handler: string;
  readonly architecture: typeof FUNCTION_SETTINGS.architecture;
  readonly memoryMb: number;
  readonly timeoutSeconds: number;
  readonly subnetIds: readonly string[];
  readonly securityGroupIds: readonly string[];
  readonly logGroupName: string;
  readonly variables: Readonly<Record<string, string>>;
  /** The bundle's object, by version, which Lambda loads the code from and keeps reading. */
  readonly code: {
    readonly bucket: string;
    readonly key: string;
    readonly versionId: string;
  };
}

export interface FunctionState {
  /** Lambda's hash of the function's code: SHA-256, in base64. */
  readonly codeSha256: string;
}

export interface AliasState {
  readonly functionVersion: string;
  readonly revisionId: string;
  /** The release that set it. `undefined` for an alias no release recorded itself on. */
  readonly releaseId: string | undefined;
  /** The version of the domain's code that release was for, `undefined` likewise. */
  readonly version: string | undefined;
}

/** Lambda, as the domain's deploy role. Each wait throws once the function can't get there. */
export interface FunctionApi {
  /** `undefined` when there is no such function. */
  getFunction(name: string): Promise<FunctionState | undefined>;
  createFunction(definition: FunctionDefinition): Promise<void>;
  updateConfiguration(definition: FunctionDefinition): Promise<void>;
  updateCode(definition: FunctionDefinition): Promise<void>;
  waitUntilActive(name: string): Promise<void>;
  /** Waits while Lambda is making or changing the function, whatever state it settles in. */
  waitUntilSettled(name: string): Promise<void>;
  waitUntilUpdated(name: string): Promise<void>;
  /** Publishes the function as it is, if its code has this hash, and answers the function version. */
  publishVersion(
    name: string,
    codeSha256: string,
    description: string,
  ): Promise<string>;
  waitUntilVersionActive(name: string, functionVersion: string): Promise<void>;
  getAlias(name: string, alias: string): Promise<AliasState | undefined>;
  createAlias(
    name: string,
    alias: string,
    functionVersion: string,
    releaseId: string,
    version: string,
  ): Promise<void>;
  /** Moves the alias, unless it changed since it was read at `revisionId`. */
  updateAlias(
    name: string,
    alias: string,
    functionVersion: string,
    revisionId: string,
    releaseId: string,
    version: string,
  ): Promise<void>;
}

export interface Network {
  readonly subnetIds: readonly string[];
  readonly securityGroupId: string;
}

/** What the worker does as a domain's deploy role. */
export interface DeployAccess {
  readNetwork(target: ReleaseTarget): Promise<Network>;
  readonly lambda: FunctionApi;
}

export interface ReleaseAws {
  /** The SHA-256, in hex, of one version of an object in the code bucket. */
  bundleSha256(bucket: string, key: string, versionId: string): Promise<string>;
  /**
   * Lambda and the parameters in the domain account, as the role. Every wait shares `timeLeft`,
   * so a slow one, such as a first create in a VPC, can take what the others didn't use.
   */
  deployAs(roleArn: string, timeLeft: TimeLeft): DeployAccess;
}

/** How long, in milliseconds, the release may still wait for Lambda. */
export type TimeLeft = () => number;

/**
 * Thrown by a wait for a function that won't reach the state, with Lambda's code for why, such as
 * `SubnetOutOfIPAddresses`. Never Lambda's message, which is free text.
 */
export class FunctionStateError extends Error {
  constructor(readonly reasonCode: string) {
    super(`The function stopped with ${reasonCode}`);
    this.name = "FunctionStateError";
  }
}

/**
 * Why a release stopped, at which step, with a fixed reason. `retry` says whether trying again
 * could go differently: a bundle that isn't what its key says never will.
 */
export class ReleaseFailure extends Error {
  constructor(
    readonly step: ReleaseStep,
    readonly reason: string,
    readonly retry: boolean,
    options?: ErrorOptions,
  ) {
    super(`The release stopped at ${step}: ${reason}`, options);
    this.name = "ReleaseFailure";
  }
}

export interface Released {
  /** The function version `live` points at. */
  readonly functionVersion: string;
  /** Whether the function was created by this release. */
  readonly created: boolean;
  /** Whether `live` moved. It doesn't when it already pointed at this function version. */
  readonly moved: boolean;
}

export async function release(
  aws: ReleaseAws,
  bucket: string,
  target: ReleaseTarget,
  request: ReleaseRequest & { readonly id: string },
  timeLeft: TimeLeft,
): Promise<Released> {
  const releaseId = request.id;
  const key = bundleKey(target.domain, request.sha256);
  const deploy = aws.deployAs(target.deployRoleArn, timeLeft);
  const { lambda } = deploy;

  // Before anything changes: a release `live` already names is done, and one `live` is ahead of
  // changes nothing.
  const current = await step("check-order", () =>
    lambda.getAlias(target.functionName, LIVE_ALIAS),
  );
  if (current?.releaseId === releaseId) {
    return {
      functionVersion: current.functionVersion,
      created: false,
      moved: false,
    };
  }
  refuseIfSuperseded(current, request, "check-order");

  // The object is the version the pipeline API found, read in full. The key names the bundle's
  // hash, so the object must have it, whoever wrote it.
  const sha256 = await step("check-bundle", () =>
    aws.bundleSha256(bucket, key, request.versionId),
  );
  if (sha256 !== request.sha256) {
    throw new ReleaseFailure("check-bundle", "bundle-hash", false);
  }

  // The deploy role refuses a function outside these subnets and this security group, so they are
  // read as the role, from the parameters it is held to.
  const network = await step("read-network", () => deploy.readNetwork(target));

  const definition: FunctionDefinition = {
    name: target.functionName,
    roleArn: target.executionRoleArn,
    runtime: FUNCTION_SETTINGS.runtime,
    handler: FUNCTION_SETTINGS.handler,
    architecture: FUNCTION_SETTINGS.architecture,
    memoryMb: FUNCTION_SETTINGS.memoryMb,
    timeoutSeconds: FUNCTION_SETTINGS.timeoutSeconds,
    subnetIds: network.subnetIds,
    securityGroupIds: [network.securityGroupId],
    logGroupName: target.logGroupName,
    // The environment's name, which code uses to build names, such as a gateway's function's.
    variables: { FLEX_ENVIRONMENT: target.environment },
    code: { bucket, key, versionId: request.versionId },
  };

  const existing = await step("read-function", () =>
    lambda.getFunction(definition.name),
  );
  if (existing === undefined) {
    await step("create-function", async () => {
      await lambda.createFunction(definition);
      // A function in a VPC can stay pending for minutes while its network interfaces are made.
      await lambda.waitUntilActive(definition.name);
    });
  } else {
    // Each update waits for the one before it: Lambda refuses a change to a function it is
    // still changing. Whatever state the function settles in, it is updated: an update
    // reactivates one idle long enough to be inactive, and may mend one that failed.
    await step("update-configuration", async () => {
      await lambda.waitUntilSettled(definition.name);
      await lambda.updateConfiguration(definition);
      await lambda.waitUntilUpdated(definition.name);
    });
    await step("update-code", async () => {
      await lambda.updateCode(definition);
      await lambda.waitUntilUpdated(definition.name);
    });
  }

  // Lambda's hash of what it loaded, in base64, against the bundle's, in hex. Compared as bytes,
  // never as text.
  const codeSha256 = Buffer.from(request.sha256, "hex").toString("base64");
  const loaded = await step("check-code", () =>
    lambda.getFunction(definition.name),
  );
  if (loaded?.codeSha256 !== codeSha256) {
    throw new ReleaseFailure("check-code", "code-hash", false);
  }

  const functionVersion = await step("publish-version", async () => {
    // Lambda publishes only if the code still has this hash, so nothing that changed the
    // function since is published.
    const published = await lambda.publishVersion(
      definition.name,
      codeSha256,
      versionDescription(request),
    );
    await lambda.waitUntilVersionActive(definition.name, published);
    return published;
  });

  const moved = await step("move-alias", async () => {
    const alias = await lambda.getAlias(definition.name, LIVE_ALIAS);
    if (alias === undefined) {
      await lambda.createAlias(
        definition.name,
        LIVE_ALIAS,
        functionVersion,
        releaseId,
        request.version,
      );
      return true;
    }
    // Again, since another release may have moved it while this one ran.
    refuseIfSuperseded(alias, request, "move-alias");
    if (
      alias.functionVersion === functionVersion &&
      alias.releaseId === releaseId
    ) {
      return false;
    }
    await lambda.updateAlias(
      definition.name,
      LIVE_ALIAS,
      functionVersion,
      alias.revisionId,
      releaseId,
      request.version,
    );
    return alias.functionVersion !== functionVersion;
  });

  return { functionVersion, created: existing === undefined, moved };
}

// Refuses a release `live` is ahead of: one asked for before the release on `live`, or one of an
// earlier version. Asked for in the same millisecond is neither: the rest of each ID is random,
// so the queue's order decides. The same version runs, so a release can bring the platform's
// settings to the code already on `live`. An alias with no release recorded on it refuses
// nothing: anything that could write its description could move it anyway.
function refuseIfSuperseded(
  alias: AliasState | undefined,
  request: ReleaseRequest & { readonly id: string },
  at: ReleaseStep,
): void {
  if (
    (alias?.releaseId !== undefined &&
      releaseRequestedAt(alias.releaseId) > releaseRequestedAt(request.id)) ||
    (alias?.version !== undefined &&
      compareBundleVersions(alias.version, request.version) > 0)
  ) {
    throw new ReleaseFailure(at, "superseded", false);
  }
}

// What a function version says it is: the bundle, and the commit it was built from when the run
// said.
function versionDescription(request: ReleaseRequest): string {
  const bundle = `bundle ${request.sha256}`;
  return request.commit === undefined
    ? bundle
    : `${bundle} from commit ${request.commit}`;
}

// Runs one step, and says which one stopped and why, in words the log can hold.
async function step<T>(name: ReleaseStep, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ReleaseFailure) throw error;
    throw new ReleaseFailure(name, reasonOf(error), true, { cause: error });
  }
}

// An AWS error's code, such as `AccessDeniedException`, which AWS chooses from a fixed set, or
// Lambda's code for a function that won't become ready. Never a message, which can quote a
// request.
const AWS_ERROR_CODE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

export function reasonOf(error: unknown): string {
  if (error instanceof FunctionStateError) {
    return AWS_ERROR_CODE.test(error.reasonCode)
      ? error.reasonCode
      : "function-state";
  }
  if (
    error instanceof Error &&
    "$metadata" in error &&
    AWS_ERROR_CODE.test(error.name)
  ) {
    return error.name;
  }
  return "unexpected";
}
