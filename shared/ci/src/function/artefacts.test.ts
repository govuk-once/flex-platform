import {
  type AttributeValue,
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";

import {
  answering,
  BUNDLE,
  COMMIT,
  CONFIG,
  VERSION,
} from "../../test/helpers.ts";
import { createArtefactFinder, createVersionClaim } from "./artefacts.ts";

const RECORDED_AT = 1_800_000_000_000;

const ARTEFACT = {
  domain: "example",
  version: VERSION,
  sha256: BUNDLE.sha256,
  runId: "12345678901",
  commit: COMMIT,
};

function claim(answer: () => object = () => ({})) {
  const client = new DynamoDBClient({ region: "eu-west-2" });
  const sent = answering(client, answer);
  return {
    claimVersion: createVersionClaim({
      uploads: CONFIG.uploads,
      now: () => RECORDED_AT,
      client,
    }),
    sent,
  };
}

function recordedAs(
  item: Record<string, AttributeValue> | undefined,
): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({
    message: "SYNTHETIC",
    $metadata: {},
    ...(item !== undefined && { Item: item }),
  });
}

describe("createVersionClaim", () => {
  it("records the version, under its domain, only where it isn't recorded, and answers its hash", async () => {
    const { claimVersion, sent } = claim();

    await expect(claimVersion(ARTEFACT)).resolves.toBe(BUNDLE.sha256);
    expect(sent).toEqual([
      {
        command: "PutItemCommand",
        input: {
          TableName: "shared-release-artefacts",
          Item: {
            domain: { S: "example" },
            version: { S: VERSION },
            sha256: { S: BUNDLE.sha256 },
            recordedAt: { N: String(RECORDED_AT) },
            runId: { S: "12345678901" },
            commit: { S: COMMIT },
          },
          ConditionExpression: "attribute_not_exists(version)",
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        },
      },
    ]);
  });

  it("records a version uploaded by a run its token didn't name without one", async () => {
    const { claimVersion, sent } = claim();

    await claimVersion({ ...ARTEFACT, runId: undefined, commit: undefined });

    expect(sent[0]?.input).toMatchObject({
      Item: expect.not.objectContaining({
        runId: expect.anything() as unknown,
        commit: expect.anything() as unknown,
      }) as unknown,
    });
  });

  it("answers the hash recorded before, for a version that is recorded", async () => {
    const other = "0".repeat(64);
    const { claimVersion } = claim(() => {
      throw recordedAs({ sha256: { S: other } });
    });

    await expect(claimVersion(ARTEFACT)).resolves.toBe(other);
  });

  it.each([
    ["no item", undefined],
    ["no hash", { version: { S: VERSION } }],
    ["a hash that isn't one", { sha256: { S: "abc" } }],
  ])(
    "fails for a version recorded with %s, rather than taking either answer",
    async (_, item) => {
      const { claimVersion } = claim(() => {
        throw recordedAs(item);
      });

      await expect(claimVersion(ARTEFACT)).rejects.toThrow(
        "holds no bundle's hash",
      );
    },
  );

  it("passes on anything else DynamoDB answers", async () => {
    const { claimVersion } = claim(() => {
      throw new TypeError("SYNTHETIC");
    });

    await expect(claimVersion(ARTEFACT)).rejects.toThrow(TypeError);
  });
});

describe("createArtefactFinder", () => {
  function find(answer: () => object) {
    const client = new DynamoDBClient({ region: "eu-west-2" });
    const sent = answering(client, answer);
    return {
      findArtefact: createArtefactFinder({ uploads: CONFIG.uploads, client }),
      sent,
    };
  }

  // Consistently, since a pipeline releases a version as soon as it uploads it.
  it("reads the hash a domain's version names, consistently", async () => {
    const { findArtefact, sent } = find(() => ({
      Item: { domain: { S: "example" }, sha256: { S: BUNDLE.sha256 } },
    }));

    await expect(findArtefact("example", VERSION)).resolves.toBe(BUNDLE.sha256);
    expect(sent).toEqual([
      {
        command: "GetItemCommand",
        input: {
          TableName: "shared-release-artefacts",
          Key: { domain: { S: "example" }, version: { S: VERSION } },
          ConsistentRead: true,
        },
      },
    ]);
  });

  it("finds nothing for a version not recorded", async () => {
    const { findArtefact } = find(() => ({}));

    await expect(findArtefact("example", VERSION)).resolves.toBeUndefined();
  });

  it("fails for a version recorded without a hash", async () => {
    const { findArtefact } = find(() => ({
      Item: { sha256: { S: "abc" } },
    }));

    await expect(findArtefact("example", VERSION)).rejects.toThrow(
      "holds no bundle's hash",
    );
  });
});
