// The release table: one item per release, under its domain in its environment, sorted by ID, so
// a domain's releases list newest first. The pipeline API records a release as `queued`, and the
// worker claims it, runs it, and records how it went.
//
// The table's policy lets no role but the API's record a release, none but the API's and the
// workers' change one, and none change what was asked for. So a release the worker finds here is
// one the API asked for, as it was asked.

import {
  type AttributeValue,
  ConditionalCheckFailedException,
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

import { isReleaseId } from "./release-id.ts";
import { parseReleaseRequest, type ReleaseRequest } from "./request.ts";

/**
 * Where a release is. `failed` will be tried again by the queue. `refused` never will be: nothing
 * about the release would change. `abandoned` was tried as often as the queue tries, and won't be
 * again: the pipeline asks again. `released` and `refused` are final. `abandoned` isn't: anything
 * IAM lets invoke the dead-letter worker could write its event, so a release the queue still holds
 * is claimed and run however it was recorded.
 */
export type ReleaseStatus =
  "queued" | "releasing" | "released" | "failed" | "refused" | "abandoned";

/** Which release: its domain in its environment, and its ID. */
export interface ReleaseKey {
  readonly environment: string;
  readonly domain: string;
  readonly id: string;
}

export interface ReleaseRecord extends ReleaseRequest {
  readonly id: string;
  readonly status: ReleaseStatus;
  /** When the API recorded it, in milliseconds since the epoch. */
  readonly requestedAt: number;
  readonly updatedAt: number;
  /** How many times the worker has claimed it. */
  readonly attempts: number;
  /** The step that stopped it, for a release that failed or was refused at one. */
  readonly step?: string;
  /** A fixed code for why it stopped. Never an error's text. */
  readonly reason?: string;
  /** The function version `live` points at, once released. */
  readonly functionVersion?: string;
  /** Whether the release created the function. */
  readonly created?: boolean;
  /** Whether `live` moved. It doesn't when it already pointed at the function version. */
  readonly moved?: boolean;
}

export type ReleaseOutcome =
  | {
      readonly status: "released";
      readonly functionVersion: string;
      readonly created: boolean;
      readonly moved: boolean;
    }
  | {
      readonly status: "failed" | "refused";
      readonly step?: string | undefined;
      readonly reason: string;
    };

export interface ReleaseTable {
  /** Records a new release as `queued`. Throws if the ID is taken. */
  create(
    id: string,
    request: ReleaseRequest,
    requestedAt: number,
  ): Promise<void>;
  /** `undefined` for no such release, or an item that isn't one. Read consistently. */
  get(key: ReleaseKey): Promise<ReleaseRecord | undefined>;
  /**
   * Takes the release for another attempt, unless it is final. Nothing stops two attempts at once:
   * Lambda refuses changes that overlap, and every step reads Lambda first, so an attempt at what
   * is done changes nothing. `false` for a final release.
   */
  claim(key: ReleaseKey, now: number): Promise<boolean>;
  /**
   * Records how the release went. `released` is what Lambda says, so it is recorded over anything
   * but `released`. Any other outcome is recorded only over `from`, the status its writer left the
   * release in, so it never overwrites another writer's. Throws when it isn't recorded.
   */
  finish(
    key: ReleaseKey,
    outcome: ReleaseOutcome,
    now: number,
    from: ReleaseStatus,
  ): Promise<void>;
  /**
   * Gives the release up, keeping why its last attempt stopped, unless it is final or given up
   * already. `false` for one that is.
   */
  abandon(key: ReleaseKey, now: number): Promise<boolean>;
}

const STATUSES: ReadonlySet<string> = new Set<ReleaseStatus>([
  "queued",
  "releasing",
  "released",
  "failed",
  "refused",
  "abandoned",
]);

// The attributes that hold the request, each a string, as the API wrote it.
const REQUEST_ATTRIBUTES = [
  "environment",
  "domain",
  "version",
  "sha256",
  "versionId",
  "runId",
  "commit",
] as const;

/**
 * What the API records of a release that nothing changes after: the request, and when it was
 * asked for. The table's policy refuses any change to them, so a release runs as it was asked.
 */
export const FIXED_ATTRIBUTES: readonly string[] = [
  ...REQUEST_ATTRIBUTES,
  "requestedAt",
];

function isReleaseStatus(value: string): value is ReleaseStatus {
  return STATUSES.has(value);
}

/** The partition: a domain in an environment. Names are platform names, which hold no "/". */
export function releaseTarget(environment: string, domain: string): string {
  return `${environment}/${domain}`;
}

export function createReleaseTable(
  client: DynamoDBClient,
  tableName: string,
): ReleaseTable {
  const keyOf = (key: ReleaseKey): Record<string, AttributeValue> => ({
    target: { S: releaseTarget(key.environment, key.domain) },
    id: { S: key.id },
  });

  return {
    create: async (id, request, requestedAt) => {
      await client.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            ...keyOf({ ...request, id }),
            environment: { S: request.environment },
            domain: { S: request.domain },
            version: { S: request.version },
            sha256: { S: request.sha256 },
            versionId: { S: request.versionId },
            ...(request.runId !== undefined && { runId: { S: request.runId } }),
            ...(request.commit !== undefined && {
              commit: { S: request.commit },
            }),
            status: { S: "queued" },
            requestedAt: { N: String(requestedAt) },
            updatedAt: { N: String(requestedAt) },
            attempts: { N: "0" },
          },
          ConditionExpression: "attribute_not_exists(id)",
        }),
      );
    },

    get: async (key) => {
      const { Item } = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: keyOf(key),
          ConsistentRead: true,
        }),
      );
      return Item === undefined ? undefined : recordOf(Item);
    },

    claim: async (key, now) => {
      try {
        await client.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: keyOf(key),
            UpdateExpression:
              "SET #status = :releasing, #updatedAt = :now ADD #attempts :one REMOVE #step, #reason",
            ConditionExpression:
              "#status IN (:queued, :releasing, :failed, :abandoned)",
            ExpressionAttributeNames: {
              "#status": "status",
              "#updatedAt": "updatedAt",
              "#attempts": "attempts",
              "#step": "step",
              "#reason": "reason",
            },
            ExpressionAttributeValues: {
              ":releasing": { S: "releasing" },
              ":queued": { S: "queued" },
              ":failed": { S: "failed" },
              ":abandoned": { S: "abandoned" },
              ":now": { N: String(now) },
              ":one": { N: "1" },
            },
          }),
        );
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return false;
        throw error;
      }
    },

    abandon: async (key, now) => {
      try {
        await client.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: keyOf(key),
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
              ":now": { N: String(now) },
            },
          }),
        );
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return false;
        throw error;
      }
    },

    finish: async (key, outcome, now, from) => {
      const set: Record<string, AttributeValue> = {
        status: { S: outcome.status },
        updatedAt: { N: String(now) },
        ...(outcome.status === "released"
          ? {
              functionVersion: { S: outcome.functionVersion },
              created: { BOOL: outcome.created },
              moved: { BOOL: outcome.moved },
            }
          : {
              reason: { S: outcome.reason },
              ...(outcome.step !== undefined && { step: { S: outcome.step } }),
            }),
      };
      const names = Object.keys(set);
      const assignments = names.map((name) => `#${name} = :${name}`).join(", ");
      await client.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: keyOf(key),
          UpdateExpression: `SET ${assignments}`,
          ConditionExpression:
            outcome.status === "released"
              ? "attribute_exists(id) AND #status <> :status"
              : "#status = :from",
          ExpressionAttributeNames: Object.fromEntries(
            names.map((name) => [`#${name}`, name]),
          ),
          ExpressionAttributeValues: {
            ...Object.fromEntries(
              Object.entries(set).map(([name, value]) => [`:${name}`, value]),
            ),
            ...(outcome.status !== "released" && { ":from": { S: from } }),
          },
        }),
      );
    },
  };
}

// A record, if the item holds one. Every field is checked, though only the API writes them, so
// nothing the worker acts on was taken on trust.
export function recordOf(
  item: Record<string, AttributeValue>,
): ReleaseRecord | undefined {
  const text = (name: string) => item[name]?.S;
  const number = (name: string) => {
    const value = item[name]?.N;
    return value === undefined ? undefined : Number(value);
  };
  const flag = (name: string) => item[name]?.BOOL;

  const fields: Record<string, string> = {};
  for (const name of REQUEST_ATTRIBUTES) {
    const value = text(name);
    if (value !== undefined) fields[name] = value;
  }
  const request = parseReleaseRequest(fields);
  const id = text("id");
  const status = text("status");
  const requestedAt = number("requestedAt");
  const updatedAt = number("updatedAt");
  const attempts = number("attempts");
  if (
    request === undefined ||
    id === undefined ||
    !isReleaseId(id) ||
    status === undefined ||
    !isReleaseStatus(status) ||
    requestedAt === undefined ||
    updatedAt === undefined ||
    attempts === undefined ||
    ![requestedAt, updatedAt, attempts].every(Number.isSafeInteger)
  ) {
    return undefined;
  }
  const step = text("step");
  const reason = text("reason");
  const functionVersion = text("functionVersion");
  const created = flag("created");
  const moved = flag("moved");
  return {
    ...request,
    id,
    status,
    requestedAt,
    updatedAt,
    attempts,
    ...(step !== undefined && { step }),
    ...(reason !== undefined && { reason }),
    ...(functionVersion !== undefined && { functionVersion }),
    ...(created !== undefined && { created }),
    ...(moved !== undefined && { moved }),
  };
}
