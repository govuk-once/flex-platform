import { uuidV7 } from "@repo/utils/uuid-v7";

import type {
  AliasState,
  DeployAccess,
  FunctionApi,
  FunctionDefinition,
  Network,
  ReleaseAws,
  TimeLeft,
} from "../src/worker/release.ts";
import type { ReleaseTarget } from "../src/worker/types.ts";

export const BUCKET = "shared-domain-code-000000000000";

export const SHA256 =
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

/** The same hash as Lambda gives it. */
export const CODE_SHA256 = Buffer.from(SHA256, "hex").toString("base64");

export const VERSION_ID = "3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY";

export const COMMIT = "0123456789abcdef0123456789abcdef01234567";

export const TARGET: ReleaseTarget = {
  environment: "development",
  domain: "example",
  deployRoleArn:
    "arn:aws:iam::200000000001:role/domain-development-example-deploy",
  functionName: "domain-development-example",
  executionRoleArn:
    "arn:aws:iam::200000000001:role/domain-development-example-execution",
  logGroupName: "/flex/domain/development/example/function",
  subnetIdsParameter: "/flex/network/development/isolated-subnet-ids",
  securityGroupIdParameter: "/flex/network/development/security-group/domain",
};

/** When the release in these tests was asked for, in milliseconds. */
export const REQUESTED_AT = 1_800_000_000_000;

/** A release ID made `offsetMs` after the release in these tests was asked for. */
export function releaseIdAt(offsetMs = 0, fill = 1): string {
  return uuidV7(REQUESTED_AT + offsetMs, new Uint8Array(10).fill(fill));
}

export const RELEASE_ID = releaseIdAt();

export const NETWORK: Network = {
  subnetIds: ["subnet-0a", "subnet-0b"],
  securityGroupId: "sg-0c",
};

export const REQUEST = {
  environment: "development",
  domain: "example",
  sha256: SHA256,
  versionId: VERSION_ID,
  runId: "12345678901",
  commit: COMMIT,
};

/** A domain account's Lambda, in memory, recording each call. */
export class FakeLambda implements FunctionApi {
  readonly calls: string[] = [];
  definition: FunctionDefinition | undefined;
  codeSha256: string;
  versions: string[] = [];
  alias: AliasState | undefined;
  /** Makes the named call throw this. */
  failures = new Map<string, unknown>();

  constructor(
    existing: {
      definition?: FunctionDefinition;
      versions?: string[];
      alias?: AliasState;
    } = {},
    /** The hash Lambda gives the code it loaded, which is the bundle's unless a test says. */
    readonly loads: string = CODE_SHA256,
  ) {
    this.definition = existing.definition;
    this.codeSha256 = existing.definition === undefined ? "" : CODE_SHA256;
    this.versions = existing.versions ?? [];
    this.alias = existing.alias;
  }

  private call(name: string): void {
    this.calls.push(name);
    if (this.failures.has(name)) throw this.failures.get(name);
  }

  getFunction(): Promise<{ codeSha256: string } | undefined> {
    this.call("getFunction");
    return Promise.resolve(
      this.definition === undefined
        ? undefined
        : { codeSha256: this.codeSha256 },
    );
  }

  createFunction(definition: FunctionDefinition): Promise<void> {
    this.call("createFunction");
    this.definition = definition;
    this.codeSha256 = this.loads;
    return Promise.resolve();
  }

  updateConfiguration(definition: FunctionDefinition): Promise<void> {
    this.call("updateConfiguration");
    this.definition = definition;
    return Promise.resolve();
  }

  updateCode(definition: FunctionDefinition): Promise<void> {
    this.call("updateCode");
    this.definition = definition;
    this.codeSha256 = this.loads;
    return Promise.resolve();
  }

  waitUntilActive(): Promise<void> {
    this.call("waitUntilActive");
    return Promise.resolve();
  }

  waitUntilSettled(): Promise<void> {
    this.call("waitUntilSettled");
    return Promise.resolve();
  }

  waitUntilUpdated(): Promise<void> {
    this.call("waitUntilUpdated");
    return Promise.resolve();
  }

  publishVersion(
    _name: string,
    codeSha256: string,
    description: string,
  ): Promise<string> {
    this.call(`publishVersion ${codeSha256} ${description}`);
    const version = String(this.versions.length + 1);
    this.versions.push(version);
    return Promise.resolve(version);
  }

  waitUntilVersionActive(_name: string, version: string): Promise<void> {
    this.call(`waitUntilVersionActive ${version}`);
    return Promise.resolve();
  }

  getAlias(): Promise<AliasState | undefined> {
    this.call("getAlias");
    return Promise.resolve(this.alias);
  }

  createAlias(
    _name: string,
    alias: string,
    version: string,
    releaseId: string,
  ): Promise<void> {
    this.call(`createAlias ${alias} ${version} ${releaseId}`);
    this.alias = { version, revisionId: "revision-1", releaseId };
    return Promise.resolve();
  }

  updateAlias(
    _name: string,
    alias: string,
    version: string,
    revisionId: string,
    releaseId: string,
  ): Promise<void> {
    this.call(`updateAlias ${alias} ${version} ${revisionId} ${releaseId}`);
    this.alias = { version, revisionId: "revision-2", releaseId };
    return Promise.resolve();
  }
}

/** AWS, as the worker sees it: the bucket holds a bundle with `held` for its hash. */
export function fakeAws(
  lambda: FakeLambda,
  options: { held?: string; network?: Network; failNetwork?: Error } = {},
) {
  const assumed: string[] = [];
  const read: string[] = [];
  const timeLimits: TimeLeft[] = [];
  const aws: ReleaseAws = {
    bundleSha256: (bucket, key, versionId) => {
      read.push(`${bucket}/${key}?versionId=${versionId}`);
      return Promise.resolve(options.held ?? SHA256);
    },
    deployAs: (roleArn, timeLeft): DeployAccess => {
      assumed.push(roleArn);
      timeLimits.push(timeLeft);
      return {
        readNetwork: () =>
          options.failNetwork === undefined
            ? Promise.resolve(options.network ?? NETWORK)
            : Promise.reject(options.failNetwork),
        lambda,
      };
    },
  };
  return { aws, assumed, read, timeLimits };
}

/** A release's time to wait for Lambda, which the fakes never use up. */
export const TIME_LEFT: TimeLeft = () => 10 * 60 * 1000;

/** An error as the AWS SDK throws one: its name is AWS's code for it. */
export function awsError(name: string, message = "SYNTHETIC message"): Error {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, { $metadata: { httpStatusCode: 400 } });
  return error;
}
