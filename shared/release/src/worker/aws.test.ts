import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import {
  LambdaClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import { assert, describe, expect, it, vi } from "vitest";

import {
  BUCKET,
  CODE_SHA256,
  NETWORK,
  RELEASE_ID,
  releaseIdAt,
  SHA256,
  TARGET,
  VERSION,
  VERSION_ID,
} from "../../test/helpers.ts";
import { type Answer, answering } from "../../test/stub-aws.ts";
import { createReleaseAws } from "./aws.ts";
import {
  FUNCTION_SETTINGS,
  type FunctionDefinition,
  FunctionStateError,
  type TimeLeft,
} from "./release.ts";

const REGION = "eu-west-2";

const KEY = `example/bundle/${SHA256}.zip`;

const DEFINITION: FunctionDefinition = {
  name: TARGET.functionName,
  roleArn: TARGET.executionRoleArn,
  ...FUNCTION_SETTINGS,
  subnetIds: NETWORK.subnetIds,
  securityGroupIds: [NETWORK.securityGroupId],
  logGroupName: TARGET.logGroupName,
  variables: { FLEX_ENVIRONMENT: "development" },
  code: { bucket: BUCKET, key: KEY, versionId: VERSION_ID },
};

// A release's time to wait, counted down by the clock from now, fake or real.
function countdown(ms = 10 * 60 * 1000): TimeLeft {
  const end = Date.now() + ms;
  return () => end - Date.now();
}

function notFound(): ResourceNotFoundException {
  return new ResourceNotFoundException({
    message: "SYNTHETIC",
    $metadata: {},
  });
}

function setUp(answers: { s3?: Answer; lambda?: Answer; ssm?: Answer }) {
  const s3 = new S3Client({ region: REGION });
  const lambda = new LambdaClient({ region: REGION });
  const ssm = new SSMClient({ region: REGION });
  const nothing: Answer = () => ({});
  const sent = {
    s3: answering(s3, answers.s3 ?? nothing),
    lambda: answering(lambda, answers.lambda ?? nothing),
    ssm: answering(ssm, answers.ssm ?? nothing),
  };
  const roles: string[] = [];
  const aws = createReleaseAws({
    s3,
    deployAs: (roleArn) => {
      roles.push(roleArn);
      return { lambda, ssm };
    },
  });
  return { aws, sent, roles };
}

// Lambda's description of a function, in the state a waiter is looking for.
function configuration(fields: Record<string, unknown>) {
  return { Configuration: { CodeSha256: CODE_SHA256, ...fields } };
}

describe("bundleSha256", () => {
  it("hashes the version of the bundle it names, as it reads it", async () => {
    const { aws, sent } = setUp({
      s3: () => ({
        Body: Readable.from([Buffer.from("a "), Buffer.from("bundle")]),
      }),
    });

    const sha256 = await aws.bundleSha256(BUCKET, KEY, VERSION_ID);

    expect(sha256).toBe(createHash("sha256").update("a bundle").digest("hex"));
    expect(sent.s3).toEqual([
      {
        command: "GetObjectCommand",
        input: { Bucket: BUCKET, Key: KEY, VersionId: VERSION_ID },
      },
    ]);
  });

  it("refuses an answer with nothing to read", async () => {
    const { aws } = setUp({ s3: () => ({}) });

    await expect(aws.bundleSha256(BUCKET, KEY, VERSION_ID)).rejects.toThrow(
      TypeError,
    );
  });
});

describe("deployAs", () => {
  it("reaches the domain account as the role it names", () => {
    const { aws, roles } = setUp({});

    aws.deployAs(TARGET.deployRoleArn, countdown());

    expect(roles).toEqual([TARGET.deployRoleArn]);
  });
});

describe("readNetwork", () => {
  it("reads the subnets and the security group from their parameters", async () => {
    const { aws, sent } = setUp({
      ssm: () => ({
        Parameters: [
          { Name: TARGET.securityGroupIdParameter, Value: "sg-0c" },
          { Name: TARGET.subnetIdsParameter, Value: "subnet-0a,subnet-0b" },
        ],
      }),
    });

    const network = await aws
      .deployAs(TARGET.deployRoleArn, countdown())
      .readNetwork(TARGET);

    expect(network).toEqual(NETWORK);
    expect(sent.ssm).toEqual([
      {
        command: "GetParametersCommand",
        input: {
          Names: [TARGET.subnetIdsParameter, TARGET.securityGroupIdParameter],
        },
      },
    ]);
  });

  it("refuses to go on without either", async () => {
    const { aws } = setUp({
      ssm: () => ({
        Parameters: [{ Name: TARGET.subnetIdsParameter, Value: "subnet-0a" }],
      }),
    });

    await expect(
      aws.deployAs(TARGET.deployRoleArn, countdown()).readNetwork(TARGET),
    ).rejects.toThrow("A network parameter is missing");
  });
});

describe("the function", () => {
  it("is read for its code's hash, and is undefined when there is none", async () => {
    let exists = true;
    const { aws } = setUp({
      lambda: () => {
        if (!exists) throw notFound();
        return configuration({});
      },
    });
    const { lambda } = aws.deployAs(TARGET.deployRoleArn, countdown());

    expect(await lambda.getFunction(DEFINITION.name)).toEqual({
      codeSha256: CODE_SHA256,
    });
    exists = false;
    expect(await lambda.getFunction(DEFINITION.name)).toBeUndefined();
  });

  it("passes on any other error reading it", async () => {
    const { aws } = setUp({
      lambda: () => {
        throw new TypeError("SYNTHETIC");
      },
    });

    await expect(
      aws
        .deployAs(TARGET.deployRoleArn, countdown())
        .lambda.getFunction(DEFINITION.name),
    ).rejects.toThrow(TypeError);
  });

  it("is created with everything the platform sets, its code read in place by version", async () => {
    const { aws, sent } = setUp({});

    await aws
      .deployAs(TARGET.deployRoleArn, countdown())
      .lambda.createFunction(DEFINITION);

    expect(sent.lambda).toEqual([
      {
        command: "CreateFunctionCommand",
        input: {
          FunctionName: TARGET.functionName,
          Role: TARGET.executionRoleArn,
          Runtime: "nodejs24.x",
          Handler: "index.handler",
          MemorySize: 1024,
          Timeout: 29,
          VpcConfig: {
            SubnetIds: ["subnet-0a", "subnet-0b"],
            SecurityGroupIds: ["sg-0c"],
          },
          LoggingConfig: { LogGroup: TARGET.logGroupName },
          Environment: { Variables: { FLEX_ENVIRONMENT: "development" } },
          TracingConfig: { Mode: "Active" },
          Code: {
            S3Bucket: BUCKET,
            S3Key: KEY,
            S3ObjectVersion: VERSION_ID,
            S3ObjectStorageMode: "REFERENCE",
          },
          Architectures: ["arm64"],
          PackageType: "Zip",
          Publish: false,
        },
      },
    ]);
  });

  it("is updated with the same settings, and its code the same way", async () => {
    const { aws, sent } = setUp({});
    const { lambda } = aws.deployAs(TARGET.deployRoleArn, countdown());

    await lambda.updateConfiguration(DEFINITION);
    await lambda.updateCode(DEFINITION);

    expect(sent.lambda).toEqual([
      {
        command: "UpdateFunctionConfigurationCommand",
        input: expect.objectContaining({
          FunctionName: TARGET.functionName,
          Role: TARGET.executionRoleArn,
          VpcConfig: {
            SubnetIds: ["subnet-0a", "subnet-0b"],
            SecurityGroupIds: ["sg-0c"],
          },
          LoggingConfig: { LogGroup: TARGET.logGroupName },
          TracingConfig: { Mode: "Active" },
        }) as unknown,
      },
      {
        command: "UpdateFunctionCodeCommand",
        input: {
          FunctionName: TARGET.functionName,
          S3Bucket: BUCKET,
          S3Key: KEY,
          S3ObjectVersion: VERSION_ID,
          S3ObjectStorageMode: "REFERENCE",
          Architectures: ["arm64"],
          Publish: false,
        },
      },
    ]);
  });
});

describe("waiting", () => {
  it("is done once the function is active", async () => {
    const { aws } = setUp({
      lambda: () =>
        configuration({ State: "Active", LastUpdateStatus: "Successful" }),
    });
    const { lambda } = aws.deployAs(TARGET.deployRoleArn, countdown());

    await expect(
      lambda.waitUntilActive(DEFINITION.name),
    ).resolves.toBeUndefined();
    await expect(
      lambda.waitUntilUpdated(DEFINITION.name),
    ).resolves.toBeUndefined();
  });

  it("stops with Lambda's code for a function that failed to become active", async () => {
    const { aws } = setUp({
      lambda: () =>
        configuration({
          State: "Failed",
          StateReason: "SYNTHETIC free text",
          StateReasonCode: "SubnetOutOfIPAddresses",
        }),
    });

    const error = await aws
      .deployAs(TARGET.deployRoleArn, countdown())
      .lambda.waitUntilActive(DEFINITION.name)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    assert.instanceOf(error, FunctionStateError);
    expect(error.reasonCode).toBe("SubnetOutOfIPAddresses");
    expect(error.message).not.toContain("SYNTHETIC");
  });

  it("stops with Lambda's code for an update that failed", async () => {
    const { aws } = setUp({
      lambda: () =>
        configuration({
          State: "Active",
          LastUpdateStatus: "Failed",
          LastUpdateStatusReasonCode: "InvalidSecurityGroup",
        }),
    });

    const error = await aws
      .deployAs(TARGET.deployRoleArn, countdown())
      .lambda.waitUntilUpdated(DEFINITION.name)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    assert.instanceOf(error, FunctionStateError);
    expect(error.reasonCode).toBe("InvalidSecurityGroup");
  });

  // Whatever state the function settles in, an update follows: one reactivates an inactive
  // function, and may mend a failed one.
  it.each([
    ["inactive", { State: "Inactive", LastUpdateStatus: "Successful" }],
    ["failed", { State: "Failed", LastUpdateStatus: "Failed" }],
    ["active", { State: "Active", LastUpdateStatus: "Successful" }],
  ])("is settled at once for a function that is %s", async (_, fields) => {
    const { aws, sent } = setUp({ lambda: () => configuration(fields) });

    await expect(
      aws
        .deployAs(TARGET.deployRoleArn, countdown())
        .lambda.waitUntilSettled(DEFINITION.name),
    ).resolves.toBeUndefined();
    expect(sent.lambda).toHaveLength(1);
  });

  it("waits while the function is pending or being updated", async () => {
    vi.useFakeTimers();
    const states = [
      { State: "Pending", LastUpdateStatus: "Successful" },
      { State: "Active", LastUpdateStatus: "InProgress" },
      { State: "Active", LastUpdateStatus: "Successful" },
    ];
    const { aws, sent } = setUp({
      lambda: () =>
        configuration(states[Math.min(sent.lambda.length - 1, 2)] ?? {}),
    });

    const settled = aws
      .deployAs(TARGET.deployRoleArn, countdown())
      .lambda.waitUntilSettled(DEFINITION.name);
    await vi.advanceTimersByTimeAsync(3000);

    await expect(settled).resolves.toBeUndefined();
    expect(sent.lambda).toHaveLength(3);
    vi.useRealTimers();
  });

  it("stops waiting for a function that stays pending once the release's time is up", async () => {
    vi.useFakeTimers();
    const { aws, sent } = setUp({
      lambda: () => configuration({ State: "Pending" }),
    });

    const settled = aws
      .deployAs(TARGET.deployRoleArn, countdown(60_000))
      .lambda.waitUntilSettled(DEFINITION.name)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    await vi.advanceTimersByTimeAsync(60_000);

    const error = await settled;
    assert.instanceOf(error, FunctionStateError);
    expect(error.reasonCode).toBe("WaitTimedOut");
    // At 0, 1, 3, 7, 15, 25, 35, 45 and 55 seconds: never more than 10 apart.
    expect(sent.lambda).toHaveLength(9);
    vi.useRealTimers();
  });

  // A first create in a VPC can take minutes, and nothing else in the release waits as long.
  it("waits as long as the release has left, reading the function at least every 10 seconds", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const reads: number[] = [];
    const { aws } = setUp({
      lambda: () => {
        reads.push(Date.now() - start);
        return configuration({
          State: Date.now() - start < 300_000 ? "Pending" : "Active",
        });
      },
    });

    const active = aws
      .deployAs(TARGET.deployRoleArn, countdown(600_000))
      .lambda.waitUntilActive(DEFINITION.name);
    await vi.advanceTimersByTimeAsync(311_000);

    await expect(active).resolves.toBeUndefined();
    const gaps = reads.slice(1).map((at, index) => at - (reads[index] ?? 0));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(10_000);
    vi.useRealTimers();
  });

  it.each([
    ["active", "waitUntilActive"],
    ["updated", "waitUntilUpdated"],
  ] as const)(
    "waits for nothing until %s once the release's time is up",
    async (_, wait) => {
      const { aws, sent } = setUp({
        lambda: () => configuration({ State: "Pending" }),
      });

      const error = await aws
        .deployAs(TARGET.deployRoleArn, () => 500)
        .lambda[wait](DEFINITION.name)
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

      assert.instanceOf(error, FunctionStateError);
      expect(error.reasonCode).toBe("WaitTimedOut");
      expect(sent.lambda).toEqual([]);
    },
  );

  it("waits for the version it publishes, by its number", async () => {
    // GetFunctionConfiguration answers with the configuration alone.
    const { aws, sent } = setUp({ lambda: () => ({ State: "Active" }) });

    await aws
      .deployAs(TARGET.deployRoleArn, countdown())
      .lambda.waitUntilVersionActive(DEFINITION.name, "3");

    expect(sent.lambda).toEqual([
      {
        command: "GetFunctionConfigurationCommand",
        input: { FunctionName: DEFINITION.name, Qualifier: "3" },
      },
    ]);
  });
});

describe("versions and the alias", () => {
  it("publishes only the code with the hash it names", async () => {
    const { aws, sent } = setUp({ lambda: () => ({ Version: "3" }) });

    const version = await aws
      .deployAs(TARGET.deployRoleArn, countdown())
      .lambda.publishVersion(DEFINITION.name, CODE_SHA256, "bundle");

    expect(version).toBe("3");
    expect(sent.lambda).toEqual([
      {
        command: "PublishVersionCommand",
        input: {
          FunctionName: DEFINITION.name,
          CodeSha256: CODE_SHA256,
          Description: "bundle",
        },
      },
    ]);
  });

  it("refuses an answer that names no version", async () => {
    const { aws } = setUp({ lambda: () => ({}) });

    await expect(
      aws
        .deployAs(TARGET.deployRoleArn, countdown())
        .lambda.publishVersion(DEFINITION.name, CODE_SHA256, "bundle"),
    ).rejects.toThrow("Lambda published no version");
  });

  it("reads the alias, with the release that set it and its version, and is undefined when there is none", async () => {
    let exists = true;
    const { aws } = setUp({
      lambda: () => {
        if (!exists) throw notFound();
        return {
          FunctionVersion: "2",
          RevisionId: "revision-1",
          Description: `Set by release ${RELEASE_ID} at version ${VERSION}`,
        };
      },
    });
    const { lambda } = aws.deployAs(TARGET.deployRoleArn, countdown());

    expect(await lambda.getAlias(DEFINITION.name, "live")).toEqual({
      functionVersion: "2",
      revisionId: "revision-1",
      releaseId: RELEASE_ID,
      version: VERSION,
    });
    exists = false;
    expect(await lambda.getAlias(DEFINITION.name, "live")).toBeUndefined();
  });

  // Anything that could write the description could move the alias anyway, so one that doesn't
  // read refuses nothing, rather than stopping the domain's releases.
  it.each([
    undefined,
    "",
    "Created by hand",
    "Set by release soon",
    // As releases described it before they had versions.
    `Set by release ${RELEASE_ID}`,
    `Set by release 00000000-0000-4000-8000-000000000000 at version ${VERSION}`,
    `Set by release ${RELEASE_ID} at version v1.4.2`,
    `Set by release ${RELEASE_ID} at version ${VERSION} and more`,
  ])(
    "reads no release or version from an alias described as %j",
    async (Description) => {
      const { aws } = setUp({
        lambda: () => ({
          FunctionVersion: "2",
          RevisionId: "revision-1",
          ...(Description !== undefined && { Description }),
        }),
      });

      const alias = await aws
        .deployAs(TARGET.deployRoleArn, countdown())
        .lambda.getAlias(DEFINITION.name, "live");

      expect(alias).toMatchObject({ releaseId: undefined, version: undefined });
    },
  );

  it("refuses an alias described without its version", async () => {
    const { aws } = setUp({ lambda: () => ({ RevisionId: "revision-1" }) });

    await expect(
      aws
        .deployAs(TARGET.deployRoleArn, countdown())
        .lambda.getAlias(DEFINITION.name, "live"),
    ).rejects.toThrow(TypeError);
  });

  it("creates the alias, and moves it only from the revision it was read at, naming the release that set it and its version", async () => {
    const { aws, sent } = setUp({});
    const { lambda } = aws.deployAs(TARGET.deployRoleArn, countdown());

    await lambda.createAlias(DEFINITION.name, "live", "1", RELEASE_ID, VERSION);
    await lambda.updateAlias(
      DEFINITION.name,
      "live",
      "2",
      "revision-1",
      releaseIdAt(1),
      "1.5.0",
    );

    expect(sent.lambda).toEqual([
      {
        command: "CreateAliasCommand",
        input: {
          FunctionName: DEFINITION.name,
          Name: "live",
          FunctionVersion: "1",
          Description: `Set by release ${RELEASE_ID} at version ${VERSION}`,
        },
      },
      {
        command: "UpdateAliasCommand",
        input: {
          FunctionName: DEFINITION.name,
          Name: "live",
          FunctionVersion: "2",
          RevisionId: "revision-1",
          Description: `Set by release ${releaseIdAt(1)} at version 1.5.0`,
        },
      },
    ]);
  });
});
