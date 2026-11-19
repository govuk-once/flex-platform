// The release's calls to AWS, through the SDK. Each is one call, or one call and its waiter: what
// to call, and when, is `release.ts`'s.

import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import {
  CreateAliasCommand,
  CreateFunctionCommand,
  type CreateFunctionCommandInput,
  GetAliasCommand,
  GetFunctionCommand,
  LambdaClient,
  PublishVersionCommand,
  ResourceNotFoundException,
  UpdateAliasCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionActiveV2,
  waitUntilFunctionUpdatedV2,
  waitUntilPublishedVersionActive,
} from "@aws-sdk/client-lambda";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";

import { isReleaseId } from "../release-id.ts";
import {
  type DeployAccess,
  type FunctionApi,
  type FunctionDefinition,
  FunctionStateError,
  type ReleaseAws,
  type TimeLeft,
} from "./release.ts";
import type { ReleaseTarget } from "./types.ts";

// What every Lambda waiter takes, the same for each.
type WaiterOptions = Parameters<typeof waitUntilFunctionActiveV2>[0];

// How often a wait reads the function, in seconds. The SDK's waiters would back off to minutes
// between reads, and give up once the next would come after the time left, so long before it ran
// out. Reading the function is cheap.
const FIRST_POLL_SECONDS = 1;
const MAX_POLL_SECONDS = 10;

// The session the worker holds in a domain account, as CloudTrail records it there.
const SESSION_NAME = "flex-release";

/** The SDK's clients the release calls through. */
export interface ReleaseClients {
  readonly s3: S3Client;
  /** Clients in a domain account, as its deploy role. */
  deployAs(roleArn: string): {
    readonly lambda: LambdaClient;
    readonly ssm: SSMClient;
  };
}

export function releaseClients(region: string): ReleaseClients {
  return {
    s3: new S3Client({ region }),
    deployAs: (roleArn) => {
      const credentials = fromTemporaryCredentials({
        params: { RoleArn: roleArn, RoleSessionName: SESSION_NAME },
        clientConfig: { region },
      });
      return {
        lambda: new LambdaClient({ region, credentials }),
        ssm: new SSMClient({ region, credentials }),
      };
    },
  };
}

export function createReleaseAws(clients: ReleaseClients): ReleaseAws {
  const { s3 } = clients;

  return {
    bundleSha256: async (bucket, key, versionId) => {
      const { Body } = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          VersionId: versionId,
        }),
      );
      if (!(Body instanceof Readable)) {
        throw new TypeError("S3 answered with no body to read");
      }
      const hash = createHash("sha256");
      for await (const chunk of Body) hash.update(chunk as Uint8Array);
      return hash.digest("hex");
    },

    deployAs: (roleArn, timeLeft) => {
      const { lambda, ssm } = clients.deployAs(roleArn);
      return deployAccess(lambda, ssm, timeLeft);
    },
  };
}

function deployAccess(
  lambda: LambdaClient,
  ssm: SSMClient,
  timeLeft: TimeLeft,
): DeployAccess {
  return {
    readNetwork: async (target: ReleaseTarget) => {
      const { Parameters = [] } = await ssm.send(
        new GetParametersCommand({
          Names: [target.subnetIdsParameter, target.securityGroupIdParameter],
        }),
      );
      const value = (name: string) => {
        const found = Parameters.find((parameter) => parameter.Name === name);
        if (found?.Value === undefined || found.Value === "") {
          throw new TypeError("A network parameter is missing");
        }
        return found.Value;
      };
      return {
        // A list parameter's value is its entries, joined with commas.
        subnetIds: value(target.subnetIdsParameter).split(","),
        securityGroupId: value(target.securityGroupIdParameter),
      };
    },
    lambda: functionApi(lambda, timeLeft),
  };
}

function functionApi(client: LambdaClient, timeLeft: TimeLeft): FunctionApi {
  // The function's state, read when a wait fails, so the log says why in Lambda's own code.
  const stoppedBecause = async (name: string, qualifier?: string) => {
    const { Configuration } = await client.send(
      new GetFunctionCommand({
        FunctionName: name,
        ...(qualifier !== undefined && { Qualifier: qualifier }),
      }),
    );
    return (
      Configuration?.StateReasonCode ??
      Configuration?.LastUpdateStatusReasonCode ??
      "WaitTimedOut"
    );
  };
  // A waiter, given what is left of the release's time. With too little left to read the function
  // even once, it times out without starting.
  const waitFor = async (
    wait: (options: WaiterOptions) => Promise<unknown>,
    name: string,
    qualifier?: string,
  ) => {
    const maxWaitTime = Math.floor(timeLeft() / 1000);
    if (maxWaitTime <= FIRST_POLL_SECONDS) {
      throw new FunctionStateError("WaitTimedOut");
    }
    try {
      await wait({
        client,
        maxWaitTime,
        minDelay: FIRST_POLL_SECONDS,
        maxDelay: MAX_POLL_SECONDS,
      });
    } catch {
      throw new FunctionStateError(await stoppedBecause(name, qualifier));
    }
  };

  return {
    getFunction: async (name) => {
      try {
        const { Configuration } = await client.send(
          new GetFunctionCommand({ FunctionName: name }),
        );
        return { codeSha256: Configuration?.CodeSha256 ?? "" };
      } catch (error) {
        if (error instanceof ResourceNotFoundException) return undefined;
        throw error;
      }
    },

    createFunction: async (definition) => {
      await client.send(
        new CreateFunctionCommand({
          ...configuration(definition),
          Code: code(definition),
          Architectures: [definition.architecture],
          PackageType: "Zip",
          Publish: false,
        }),
      );
    },

    updateConfiguration: async (definition) => {
      await client.send(
        new UpdateFunctionConfigurationCommand(configuration(definition)),
      );
    },

    updateCode: async (definition) => {
      await client.send(
        new UpdateFunctionCodeCommand({
          FunctionName: definition.name,
          ...code(definition),
          Architectures: [definition.architecture],
          Publish: false,
        }),
      );
    },

    waitUntilActive: (name) =>
      waitFor(
        (options) => waitUntilFunctionActiveV2(options, { FunctionName: name }),
        name,
      ),

    // Not an SDK waiter: each waits for one state, and keeps waiting through any it doesn't name,
    // such as `Inactive`, which no wait ends.
    waitUntilSettled: async (name) => {
      for (
        let delay = FIRST_POLL_SECONDS * 1000;
        ;
        delay = Math.min(delay * 2, MAX_POLL_SECONDS * 1000)
      ) {
        const { Configuration } = await client.send(
          new GetFunctionCommand({ FunctionName: name }),
        );
        if (
          Configuration?.State !== "Pending" &&
          Configuration?.LastUpdateStatus !== "InProgress"
        ) {
          return;
        }
        if (delay > timeLeft()) {
          throw new FunctionStateError("WaitTimedOut");
        }
        // In the loop, since each poll waits for the one before it.
        await new Promise((resolve) => setTimeout(resolve, delay)); // NOSONAR
      }
    },

    waitUntilUpdated: (name) =>
      waitFor(
        (options) =>
          waitUntilFunctionUpdatedV2(options, { FunctionName: name }),
        name,
      ),

    publishVersion: async (name, codeSha256, description) => {
      const { Version } = await client.send(
        new PublishVersionCommand({
          FunctionName: name,
          CodeSha256: codeSha256,
          Description: description,
        }),
      );
      if (Version === undefined) {
        throw new TypeError("Lambda published no version");
      }
      return Version;
    },

    waitUntilVersionActive: (name, functionVersion) =>
      waitFor(
        (options) =>
          waitUntilPublishedVersionActive(options, {
            FunctionName: name,
            Qualifier: functionVersion,
          }),
        name,
        functionVersion,
      ),

    getAlias: async (name, alias) => {
      try {
        const { FunctionVersion, RevisionId, Description } = await client.send(
          new GetAliasCommand({ FunctionName: name, Name: alias }),
        );
        if (FunctionVersion === undefined || RevisionId === undefined) {
          throw new TypeError("Lambda described the alias without its version");
        }
        return {
          functionVersion: FunctionVersion,
          revisionId: RevisionId,
          releaseId: releaseIdOf(Description),
        };
      } catch (error) {
        if (error instanceof ResourceNotFoundException) return undefined;
        throw error;
      }
    },

    createAlias: async (name, alias, functionVersion, releaseId) => {
      await client.send(
        new CreateAliasCommand({
          FunctionName: name,
          Name: alias,
          FunctionVersion: functionVersion,
          Description: aliasDescription(releaseId),
        }),
      );
    },

    updateAlias: async (
      name,
      alias,
      functionVersion,
      revisionId,
      releaseId,
    ) => {
      await client.send(
        new UpdateAliasCommand({
          FunctionName: name,
          Name: alias,
          FunctionVersion: functionVersion,
          RevisionId: revisionId,
          Description: aliasDescription(releaseId),
        }),
      );
    },
  };
}

// The alias's description names the release that set it, which the next release reads to refuse
// one asked for earlier. Nothing else writes it.
const ALIAS_DESCRIPTION = /^Set by release ([0-9a-f-]{36})$/;

function aliasDescription(releaseId: string): string {
  return `Set by release ${releaseId}`;
}

function releaseIdOf(description: string | undefined): string | undefined {
  const releaseId = ALIAS_DESCRIPTION.exec(description ?? "")?.[1];
  return releaseId !== undefined && isReleaseId(releaseId)
    ? releaseId
    : undefined;
}

// The settings CreateFunction and UpdateFunctionConfiguration share.
function configuration(definition: FunctionDefinition) {
  return {
    FunctionName: definition.name,
    Role: definition.roleArn,
    Runtime: definition.runtime,
    Handler: definition.handler,
    MemorySize: definition.memoryMb,
    Timeout: definition.timeoutSeconds,
    VpcConfig: {
      SubnetIds: [...definition.subnetIds],
      SecurityGroupIds: [...definition.securityGroupIds],
    },
    LoggingConfig: { LogGroup: definition.logGroupName },
    Environment: { Variables: { ...definition.variables } },
    TracingConfig: { Mode: "Active" },
  } satisfies Partial<CreateFunctionCommandInput>;
}

// Lambda reads the code from the bucket, by S3 version, and keeps no copy of its own. So a bundle
// a function version uses must stay in the bucket, which refuses to delete one. Left out, the mode is a copy.
function code(definition: FunctionDefinition) {
  return {
    S3Bucket: definition.code.bucket,
    S3Key: definition.code.key,
    S3ObjectVersion: definition.code.versionId,
    S3ObjectStorageMode: "REFERENCE",
  } as const;
}
