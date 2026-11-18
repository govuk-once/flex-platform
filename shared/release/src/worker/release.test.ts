import { assert, describe, expect, it } from "vitest";

import {
  awsError,
  BUCKET,
  CODE_SHA256,
  COMMIT,
  fakeAws,
  FakeLambda,
  NETWORK,
  RELEASE_ID,
  releaseIdAt,
  REQUEST,
  SHA256,
  TARGET,
  TIME_LEFT,
  VERSION_ID,
} from "../../test/helpers.ts";
import {
  FUNCTION_SETTINGS,
  FunctionStateError,
  reasonOf,
  release,
  ReleaseFailure,
} from "./release.ts";

const DESCRIPTION = `bundle ${SHA256} from commit ${COMMIT}`;

async function failure(promise: Promise<unknown>): Promise<ReleaseFailure> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.instanceOf(error, ReleaseFailure);
  return error;
}

describe("release", () => {
  it("creates the function the first time, publishes it, and points live at it", async () => {
    const lambda = new FakeLambda();
    const { aws, assumed, read, timeLimits } = fakeAws(lambda);

    const released = await release(
      aws,
      BUCKET,
      TARGET,
      {
        ...REQUEST,
        id: RELEASE_ID,
      },
      TIME_LEFT,
    );

    expect(released).toEqual({ version: "1", created: true, moved: true });
    expect(read).toEqual([
      `${BUCKET}/example/bundle/${SHA256}.zip?versionId=${VERSION_ID}`,
    ]);
    expect(assumed).toEqual([TARGET.deployRoleArn]);
    // Every wait shares the release's time.
    expect(timeLimits).toEqual([TIME_LEFT]);
    expect(lambda.calls).toEqual([
      "getAlias",
      "getFunction",
      "createFunction",
      "waitUntilActive",
      "getFunction",
      `publishVersion ${CODE_SHA256} ${DESCRIPTION}`,
      "waitUntilVersionActive 1",
      "getAlias",
      `createAlias live 1 ${RELEASE_ID}`,
    ]);
  });

  it("sets everything the platform decides, and the bundle by its version", async () => {
    const lambda = new FakeLambda();

    await release(
      fakeAws(lambda).aws,
      BUCKET,
      TARGET,
      {
        ...REQUEST,
        id: RELEASE_ID,
      },
      TIME_LEFT,
    );

    expect(lambda.definition).toEqual({
      name: TARGET.functionName,
      roleArn: TARGET.executionRoleArn,
      ...FUNCTION_SETTINGS,
      subnetIds: NETWORK.subnetIds,
      securityGroupIds: [NETWORK.securityGroupId],
      logGroupName: TARGET.logGroupName,
      variables: { FLEX_ENVIRONMENT: "development" },
      code: {
        bucket: BUCKET,
        key: `example/bundle/${SHA256}.zip`,
        versionId: VERSION_ID,
      },
    });
  });

  it("updates a function that exists, one change at a time, and moves live from where it was read", async () => {
    const lambda = new FakeLambda({
      definition: {
        name: TARGET.functionName,
        roleArn: TARGET.executionRoleArn,
        ...FUNCTION_SETTINGS,
        subnetIds: NETWORK.subnetIds,
        securityGroupIds: [NETWORK.securityGroupId],
        logGroupName: TARGET.logGroupName,
        variables: {},
        code: { bucket: BUCKET, key: "example/bundle/old.zip", versionId: "1" },
      },
      versions: ["1"],
      alias: {
        version: "1",
        revisionId: "revision-1",
        releaseId: releaseIdAt(-1),
      },
    });

    const released = await release(
      fakeAws(lambda).aws,
      BUCKET,
      TARGET,
      {
        ...REQUEST,
        id: RELEASE_ID,
      },
      TIME_LEFT,
    );

    expect(released).toEqual({ version: "2", created: false, moved: true });
    expect(lambda.calls).toEqual([
      "getAlias",
      "getFunction",
      "waitUntilSettled",
      "updateConfiguration",
      "waitUntilUpdated",
      "updateCode",
      "waitUntilUpdated",
      "getFunction",
      `publishVersion ${CODE_SHA256} ${DESCRIPTION}`,
      "waitUntilVersionActive 2",
      "getAlias",
      `updateAlias live 2 revision-1 ${RELEASE_ID}`,
    ]);
  });

  it("leaves live where it is when it already points at the version", async () => {
    const lambda = new FakeLambda();
    const { aws } = fakeAws(lambda);
    await release(
      aws,
      BUCKET,
      TARGET,
      { ...REQUEST, id: RELEASE_ID },
      TIME_LEFT,
    );
    // Lambda publishes nothing new for a function that hasn't changed, and answers the version
    // it has.
    lambda.publishVersion = () => Promise.resolve("1");
    lambda.calls.length = 0;

    const released = await release(
      aws,
      BUCKET,
      TARGET,
      {
        ...REQUEST,
        id: RELEASE_ID,
      },
      TIME_LEFT,
    );

    expect(released).toEqual({ version: "1", created: false, moved: false });
    expect(lambda.calls).not.toContainEqual(
      expect.stringMatching(/^(?:create|update)Alias/),
    );
  });

  // Lambda says it is done, so running it again, however it was asked for, changes nothing.
  it("does nothing for a release live already names, not even reading the bundle", async () => {
    const lambda = new FakeLambda({
      versions: ["1", "2"],
      alias: { version: "2", revisionId: "revision-1", releaseId: RELEASE_ID },
    });
    const { aws, read } = fakeAws(lambda);

    const released = await release(
      aws,
      BUCKET,
      TARGET,
      {
        ...REQUEST,
        id: RELEASE_ID,
      },
      TIME_LEFT,
    );

    expect(released).toEqual({ version: "2", created: false, moved: false });
    expect(read).toEqual([]);
    expect(lambda.calls).toEqual(["getAlias"]);
  });

  // A release run again later, however it was asked for, can't roll a domain back.
  it("changes nothing for a release asked for before the one on live, for good", async () => {
    const lambda = new FakeLambda({
      versions: ["1"],
      alias: {
        version: "1",
        revisionId: "revision-1",
        releaseId: releaseIdAt(1),
      },
    });

    const error = await failure(
      release(
        fakeAws(lambda).aws,
        BUCKET,
        TARGET,
        {
          ...REQUEST,
          id: RELEASE_ID,
        },
        TIME_LEFT,
      ),
    );

    expect(error).toMatchObject({
      step: "check-order",
      reason: "superseded",
      retry: false,
    });
    expect(lambda.calls).toEqual(["getAlias"]);
  });

  it("leaves live alone when a newer release moved it while this one ran", async () => {
    const lambda = new FakeLambda();
    const { aws } = fakeAws(lambda);
    const publish = lambda.publishVersion.bind(lambda);
    lambda.publishVersion = async (name, codeSha256, description) => {
      const version = await publish(name, codeSha256, description);
      lambda.alias = {
        version: "9",
        revisionId: "revision-9",
        releaseId: releaseIdAt(1),
      };
      return version;
    };

    const error = await failure(
      release(aws, BUCKET, TARGET, { ...REQUEST, id: RELEASE_ID }, TIME_LEFT),
    );

    expect(error).toMatchObject({ step: "move-alias", reason: "superseded" });
    expect(lambda.alias?.version).toBe("9");
  });

  it("records a newer release on live without moving it when the version is the same", async () => {
    const lambda = new FakeLambda();
    const { aws } = fakeAws(lambda);
    await release(
      aws,
      BUCKET,
      TARGET,
      { ...REQUEST, id: RELEASE_ID },
      TIME_LEFT,
    );
    lambda.publishVersion = () => Promise.resolve("1");

    const released = await release(
      aws,
      BUCKET,
      TARGET,
      {
        ...REQUEST,
        id: releaseIdAt(1),
      },
      TIME_LEFT,
    );

    expect(released).toEqual({ version: "1", created: false, moved: false });
    expect(lambda.alias).toEqual({
      version: "1",
      revisionId: "revision-2",
      releaseId: releaseIdAt(1),
    });
  });

  it("moves an alias no release recorded itself on", async () => {
    const lambda = new FakeLambda({
      versions: ["1"],
      alias: { version: "1", revisionId: "revision-1", releaseId: undefined },
    });
    lambda.definition = undefined;

    const released = await release(
      fakeAws(lambda).aws,
      BUCKET,
      TARGET,
      {
        ...REQUEST,
        id: RELEASE_ID,
      },
      TIME_LEFT,
    );

    expect(released.moved).toBe(true);
    expect(lambda.alias?.releaseId).toBe(RELEASE_ID);
  });

  it("describes a version by its bundle alone when the run named no commit", async () => {
    const lambda = new FakeLambda();
    const request = { ...REQUEST, commit: undefined };

    await release(
      fakeAws(lambda).aws,
      BUCKET,
      TARGET,
      {
        ...request,
        id: RELEASE_ID,
      },
      TIME_LEFT,
    );

    expect(lambda.calls).toContain(
      `publishVersion ${CODE_SHA256} bundle ${SHA256}`,
    );
  });

  it("refuses a bundle whose bytes aren't what its key says, before it changes anything in Lambda, for good", async () => {
    const lambda = new FakeLambda();
    const { aws, assumed } = fakeAws(lambda, { held: "0".repeat(64) });

    const error = await failure(
      release(aws, BUCKET, TARGET, { ...REQUEST, id: RELEASE_ID }, TIME_LEFT),
    );

    expect(error).toMatchObject({
      step: "check-bundle",
      reason: "bundle-hash",
      retry: false,
    });
    expect(assumed).toEqual([TARGET.deployRoleArn]);
    expect(lambda.calls).toEqual(["getAlias"]);
  });

  it("publishes nothing when Lambda loaded other code than the bundle, for good", async () => {
    const lambda = new FakeLambda({}, "b3RoZXIgY29kZQ==");

    const error = await failure(
      release(
        fakeAws(lambda).aws,
        BUCKET,
        TARGET,
        {
          ...REQUEST,
          id: RELEASE_ID,
        },
        TIME_LEFT,
      ),
    );

    expect(error).toMatchObject({
      step: "check-code",
      reason: "code-hash",
      retry: false,
    });
    expect(lambda.versions).toEqual([]);
    expect(lambda.alias).toBeUndefined();
  });

  it("names the step that failed and AWS's code for why, to try again", async () => {
    const lambda = new FakeLambda();
    lambda.failures.set(
      "createFunction",
      awsError("AccessDeniedException", "SYNTHETIC arn:aws:iam::1:role/x"),
    );

    const error = await failure(
      release(
        fakeAws(lambda).aws,
        BUCKET,
        TARGET,
        {
          ...REQUEST,
          id: RELEASE_ID,
        },
        TIME_LEFT,
      ),
    );

    expect(error).toMatchObject({
      step: "create-function",
      reason: "AccessDeniedException",
      retry: true,
    });
    expect(error.message).not.toContain("SYNTHETIC");
  });

  it("changes nothing in Lambda when the network can't be read", async () => {
    const lambda = new FakeLambda();
    const { aws } = fakeAws(lambda, {
      failNetwork: awsError("ParameterNotFound"),
    });

    const error = await failure(
      release(aws, BUCKET, TARGET, { ...REQUEST, id: RELEASE_ID }, TIME_LEFT),
    );

    expect(error).toMatchObject({
      step: "read-network",
      reason: "ParameterNotFound",
    });
    expect(lambda.calls).toEqual(["getAlias"]);
  });

  it("names Lambda's code for a function that won't become ready", async () => {
    const lambda = new FakeLambda();
    lambda.failures.set(
      "waitUntilActive",
      new FunctionStateError("SubnetOutOfIPAddresses"),
    );

    const error = await failure(
      release(
        fakeAws(lambda).aws,
        BUCKET,
        TARGET,
        {
          ...REQUEST,
          id: RELEASE_ID,
        },
        TIME_LEFT,
      ),
    );

    expect(error).toMatchObject({
      step: "create-function",
      reason: "SubnetOutOfIPAddresses",
    });
  });
});

describe("reasonOf", () => {
  it.each<[string, unknown, string]>([
    [
      "an AWS error's code",
      awsError("ResourceConflictException"),
      "ResourceConflictException",
    ],
    [
      "Lambda's code for a function's state",
      new FunctionStateError("InvalidSubnet"),
      "InvalidSubnet",
    ],
    [
      "a state code that isn't a code",
      new FunctionStateError("not a code"),
      "function-state",
    ],
    [
      "an error without AWS's metadata",
      new TypeError("SYNTHETIC"),
      "unexpected",
    ],
    [
      "an AWS error whose name isn't a code",
      awsError("Access denied: SYNTHETIC"),
      "unexpected",
    ],
    ["something that isn't an error", "SYNTHETIC", "unexpected"],
  ])("gives %s", (_, error, reason) => {
    expect(reasonOf(error)).toBe(reason);
  });
});
