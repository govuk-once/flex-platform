import {
  type AttributeValue,
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";

import {
  COMMIT,
  RELEASE_ID,
  REQUEST,
  REQUESTED_AT,
  SHA256,
  VERSION_ID,
} from "../test/helpers.ts";
import { type Answer, answering } from "../test/stub-aws.ts";
import { createReleaseTable, recordOf } from "./table.ts";

const TABLE = "shared-releases";

const KEY = { environment: "development", domain: "example", id: RELEASE_ID };

const ITEM_KEY = {
  target: { S: "development/example" },
  id: { S: RELEASE_ID },
};

const ITEM: Record<string, AttributeValue> = {
  ...ITEM_KEY,
  environment: { S: "development" },
  domain: { S: "example" },
  sha256: { S: SHA256 },
  versionId: { S: VERSION_ID },
  runId: { S: "12345678901" },
  commit: { S: COMMIT },
  status: { S: "queued" },
  requestedAt: { N: String(REQUESTED_AT) },
  updatedAt: { N: String(REQUESTED_AT) },
  attempts: { N: "0" },
};

function setUp(answer: Answer = () => ({})) {
  const client = new DynamoDBClient({ region: "eu-west-2" });
  const sent = answering(client, answer);
  return { table: createReleaseTable(client, TABLE), sent };
}

function conditionFailed(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({
    message: "SYNTHETIC",
    $metadata: {},
  });
}

describe("createReleaseTable", () => {
  it("records a release as queued, under its domain in its environment, never over another", async () => {
    const { table, sent } = setUp();

    await table.create(RELEASE_ID, REQUEST, REQUESTED_AT);

    expect(sent).toEqual([
      {
        command: "PutItemCommand",
        input: {
          TableName: TABLE,
          Item: ITEM,
          ConditionExpression: "attribute_not_exists(id)",
        },
      },
    ]);
  });

  it("records a request that named no run or commit without them", async () => {
    const { table, sent } = setUp();
    await table.create(
      RELEASE_ID,
      { ...REQUEST, runId: undefined, commit: undefined },
      REQUESTED_AT,
    );

    expect(sent[0]?.input).not.toHaveProperty("Item.runId");
    expect(sent[0]?.input).not.toHaveProperty("Item.commit");
  });

  it("reads a release consistently, and is undefined for none", async () => {
    let item: unknown = ITEM;
    const { table, sent } = setUp(() => ({ Item: item }));

    expect(await table.get(KEY)).toEqual({
      ...REQUEST,
      id: RELEASE_ID,
      status: "queued",
      requestedAt: REQUESTED_AT,
      updatedAt: REQUESTED_AT,
      attempts: 0,
    });
    item = undefined;
    expect(await table.get(KEY)).toBeUndefined();
    expect(sent[0]).toEqual({
      command: "GetItemCommand",
      input: { TableName: TABLE, Key: ITEM_KEY, ConsistentRead: true },
    });
  });

  it("claims a release for another attempt unless it is final", async () => {
    const { table, sent } = setUp();

    await expect(table.claim(KEY, 1000)).resolves.toBe(true);
    expect(sent[0]).toMatchObject({
      command: "UpdateItemCommand",
      input: {
        Key: ITEM_KEY,
        UpdateExpression:
          "SET #status = :releasing, #updatedAt = :now ADD #attempts :one REMOVE #step, #reason",
        ConditionExpression: "#status IN (:queued, :releasing, :failed)",
        ExpressionAttributeValues: { ":now": { N: "1000" } },
      },
    });
  });

  it("is false for a release it can't claim, and throws anything else", async () => {
    let error: Error = conditionFailed();
    const { table } = setUp(() => {
      throw error;
    });

    await expect(table.claim(KEY, 1000)).resolves.toBe(false);
    error = new TypeError("SYNTHETIC");
    await expect(table.claim(KEY, 1000)).rejects.toThrow(TypeError);
  });

  // Lambda says what is released, so that is recorded over whatever another writer left.
  it("records a release as released over anything but released", async () => {
    const { table, sent } = setUp();

    await table.finish(
      KEY,
      { status: "released", version: "2", created: false, moved: true },
      3000,
      "releasing",
    );

    expect(sent[0]?.input).toEqual({
      TableName: TABLE,
      Key: ITEM_KEY,
      UpdateExpression:
        "SET #status = :status, #updatedAt = :updatedAt, #version = :version, #created = :created, #moved = :moved",
      ConditionExpression: "attribute_exists(id) AND #status <> :status",
      ExpressionAttributeNames: {
        "#status": "status",
        "#updatedAt": "updatedAt",
        "#version": "version",
        "#created": "created",
        "#moved": "moved",
      },
      ExpressionAttributeValues: {
        ":status": { S: "released" },
        ":updatedAt": { N: "3000" },
        ":version": { S: "2" },
        ":created": { BOOL: false },
        ":moved": { BOOL: true },
      },
    });
  });

  it("records any other outcome only over the status its writer left", async () => {
    const { table, sent } = setUp();

    await table.finish(
      KEY,
      { status: "failed", step: "create-function", reason: "EniLimitExceeded" },
      4000,
      "releasing",
    );

    expect(sent[0]?.input).toMatchObject({
      ConditionExpression: "#status = :from",
      ExpressionAttributeValues: {
        ":status": { S: "failed" },
        ":updatedAt": { N: "4000" },
        ":reason": { S: "EniLimitExceeded" },
        ":step": { S: "create-function" },
        ":from": { S: "releasing" },
      },
    });
  });

  it("gives a release up unless it is final, keeping why its last attempt stopped", async () => {
    let error: Error | undefined;
    const { table, sent } = setUp(() => {
      if (error !== undefined) throw error;
      return {};
    });

    await expect(table.abandon(KEY, 5000)).resolves.toBe(true);
    error = conditionFailed();
    await expect(table.abandon(KEY, 5000)).resolves.toBe(false);
    error = new TypeError("SYNTHETIC");
    await expect(table.abandon(KEY, 5000)).rejects.toThrow(TypeError);
    expect(sent[0]?.input).toEqual({
      TableName: TABLE,
      Key: ITEM_KEY,
      UpdateExpression: "SET #status = :abandoned, #updatedAt = :now",
      ConditionExpression: "#status IN (:queued, :releasing, :failed)",
      ExpressionAttributeNames: {
        "#status": "status",
        "#updatedAt": "updatedAt",
      },
      ExpressionAttributeValues: {
        ":abandoned": { S: "abandoned" },
        ":queued": { S: "queued" },
        ":releasing": { S: "releasing" },
        ":failed": { S: "failed" },
        ":now": { N: "5000" },
      },
    });
  });

  it("throws when the condition fails", async () => {
    const { table } = setUp(() => {
      throw conditionFailed();
    });

    await expect(
      table.finish(
        KEY,
        { status: "refused", reason: "not-queued" },
        4000,
        "queued",
      ),
    ).rejects.toThrow(ConditionalCheckFailedException);
  });
});

describe("recordOf", () => {
  it("reads what a release went on to record", () => {
    expect(
      recordOf({
        ...ITEM,
        status: { S: "released" },
        attempts: { N: "2" },
        version: { S: "3" },
        created: { BOOL: false },
        moved: { BOOL: true },
      }),
    ).toMatchObject({
      status: "released",
      attempts: 2,
      version: "3",
      moved: true,
    });
  });

  it.each<[string, Record<string, AttributeValue | undefined>]>([
    ["a status it doesn't know", { status: { S: "done" } }],
    ["an ID that isn't a release's", { id: { S: "1" } }],
    ["a hash that isn't one", { sha256: { S: "abc" } }],
    ["no request time", { requestedAt: undefined }],
    ["a count that isn't whole", { attempts: { N: "0.5" } }],
    ["a name given as a number", { domain: { N: "1" } }],
  ])("is undefined for an item with %s", (_, change) => {
    const item = Object.fromEntries(
      Object.entries({ ...ITEM, ...change }).filter(
        (entry): entry is [string, AttributeValue] => entry[1] !== undefined,
      ),
    );

    expect(recordOf(item)).toBeUndefined();
  });
});
