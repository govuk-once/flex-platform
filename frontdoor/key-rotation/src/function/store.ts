// Rotation's state, in a kind's two tables, each keyed by `keyId`:
//
//   private keys  { keyId, privateKey, activeFrom, activeUntil? }, one per key held
//   public keys   { keyId, publicKey, activeFrom, activeUntil? }, one per key held
//                 { keyId, revokedAt }, one per key revoked in the last day, in its key's place
//                 { keyId: "#version", version }, how many times the tables have changed
//
// Every change is one transaction across both tables, and writes the version item only if it is
// still at the version the change was worked out from. DynamoDB allows one action on an item in a
// transaction, so the condition is on that write rather than a check beside it. A writer whose view
// is stale writes nothing.

import { randomUUID } from "node:crypto";

import {
  type AttributeValue,
  type DynamoDBClient,
  ScanCommand,
  TransactionCanceledException,
  type TransactWriteItem,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { isKeyId, type PrivateKeyItem } from "@repo/frontdoor-shared";

import type { RotationPorts } from "./rotation.ts";
import type { HeldKey, KeyState, RevokedKey } from "./state.ts";

/** The version item's key: never a key ID. */
export const VERSION_ITEM = "#version";

type Item = Record<string, AttributeValue>;

export interface KeyTables {
  readonly privateKeys: string;
  readonly publicKeys: string;
}

class NotAKeyState extends Error {
  constructor(table: string) {
    super(`The table ${table} doesn't hold a key state`);
  }
}

// Each page of a consistent scan, in order: a page starts where the one before it ended.
async function* pages(
  dynamodb: Pick<DynamoDBClient, "send">,
  table: string,
  start?: Item,
): AsyncGenerator<Item[]> {
  const page = await dynamodb.send(
    new ScanCommand({
      TableName: table,
      ConsistentRead: true,
      ...(start !== undefined && { ExclusiveStartKey: start }),
    }),
  );
  yield page.Items ?? [];
  if (page.LastEvaluatedKey !== undefined) {
    yield* pages(dynamodb, table, page.LastEvaluatedKey);
  }
}

async function scan(
  dynamodb: Pick<DynamoDBClient, "send">,
  table: string,
): Promise<Item[]> {
  const items: Item[] = [];
  for await (const page of pages(dynamodb, table)) items.push(...page);
  return items;
}

const time = (value: AttributeValue | undefined): number | undefined => {
  if (value?.N === undefined) return undefined;
  const number = Number(value.N);
  return Number.isSafeInteger(number) ? number : undefined;
};

interface Times {
  readonly activeFrom: number;
  readonly activeUntil?: number;
}

function timesOf(item: Item): Times | undefined {
  const activeFrom = time(item.activeFrom);
  const activeUntil = time(item.activeUntil);
  if (activeFrom === undefined) return undefined;
  if (item.activeUntil === undefined) return { activeFrom };
  if (activeUntil === undefined || activeUntil <= activeFrom) return undefined;
  return { activeFrom, activeUntil };
}

const timeItem = ({ activeFrom, activeUntil }: Times) => ({
  activeFrom: { N: String(activeFrom) },
  ...(activeUntil !== undefined && { activeUntil: { N: String(activeUntil) } }),
});

function privateItem(key: HeldKey): PrivateKeyItem & Item {
  return {
    keyId: { S: key.keyId },
    privateKey: { B: key.privateKey },
    ...timeItem(key),
  };
}

function publicItem(key: HeldKey): Item {
  return {
    keyId: { S: key.keyId },
    publicKey: { B: key.publicKey },
    ...timeItem(key),
  };
}

function revokedItem({ keyId, revokedAt }: RevokedKey): Item {
  return { keyId: { S: keyId }, revokedAt: { N: String(revokedAt) } };
}

type HeldPrivateKey = Times & { readonly privateKey: Uint8Array };

// Every private key, by key ID. An item that isn't one stops the run.
function privateKeysOf(
  table: string,
  items: readonly Item[],
): Map<string, HeldPrivateKey> {
  const keys = new Map<string, HeldPrivateKey>();
  for (const item of items) {
    const keyId = item.keyId?.S;
    const privateKey = item.privateKey?.B;
    const times = timesOf(item);
    if (
      keyId === undefined ||
      !isKeyId(keyId) ||
      privateKey === undefined ||
      times === undefined
    ) {
      throw new NotAKeyState(table);
    }
    keys.set(keyId, { privateKey, ...times });
  }
  return keys;
}

type PublicItem =
  | { readonly kind: "version"; readonly version: number }
  | { readonly kind: "revoked"; readonly revoked: RevokedKey }
  | {
      readonly kind: "key";
      readonly keyId: string;
      readonly publicKey: Uint8Array;
      readonly times: Times;
    };

// What one item of the public keys table is. An item that is none of them stops the run.
function publicItemOf(table: string, item: Item): PublicItem {
  const keyId = item.keyId?.S;
  if (keyId === VERSION_ITEM) {
    const version = time(item.version);
    if (version === undefined || version < 1) throw new NotAKeyState(table);
    return { kind: "version", version };
  }
  if (keyId === undefined || !isKeyId(keyId)) throw new NotAKeyState(table);
  if (item.revokedAt !== undefined) {
    const revokedAt = time(item.revokedAt);
    if (revokedAt === undefined || item.publicKey !== undefined) {
      throw new NotAKeyState(table);
    }
    return { kind: "revoked", revoked: { keyId, revokedAt } };
  }
  const publicKey = item.publicKey?.B;
  const times = timesOf(item);
  if (publicKey === undefined || times === undefined) {
    throw new NotAKeyState(table);
  }
  return { kind: "key", keyId, publicKey, times };
}

/**
 * Reads the two tables into one state. Anything it can't read, or a key one table holds and the
 * other doesn't, or holds with other times, stops the run, changing nothing.
 */
export function stateOf(
  tables: KeyTables,
  privateItems: readonly Item[],
  publicItems: readonly Item[],
): KeyState {
  const privateKeys = privateKeysOf(tables.privateKeys, privateItems);
  let version = 0;
  const keys: HeldKey[] = [];
  const revoked: RevokedKey[] = [];
  for (const item of publicItems) {
    const read = publicItemOf(tables.publicKeys, item);
    if (read.kind === "version") {
      version = read.version;
    } else if (read.kind === "revoked") {
      revoked.push(read.revoked);
    } else {
      const { keyId, publicKey, times } = read;
      const held = privateKeys.get(keyId);
      if (
        held?.activeFrom !== times.activeFrom ||
        held.activeUntil !== times.activeUntil
      ) {
        throw new NotAKeyState(tables.privateKeys);
      }
      keys.push({ keyId, publicKey, privateKey: held.privateKey, ...times });
    }
  }
  // A private key with no public key, such as a revoked key's.
  if (keys.length !== privateKeys.size) {
    throw new NotAKeyState(tables.privateKeys);
  }
  // Without a version, the tables have never changed, so they hold nothing.
  if (version === 0 && (keys.length > 0 || revoked.length > 0)) {
    throw new NotAKeyState(tables.publicKeys);
  }
  return { version, keys, revoked };
}

/** Reads and changes a kind's tables. */
export function tablePorts(
  dynamodb: Pick<DynamoDBClient, "send">,
  tables: KeyTables,
): Pick<RotationPorts, "read" | "commit"> {
  const key = (keyId: string) => ({ keyId: { S: keyId } });
  const put = (TableName: string, Item: Item): TransactWriteItem => ({
    Put: { TableName, Item },
  });
  const remove = (TableName: string, keyId: string): TransactWriteItem => ({
    Delete: { TableName, Key: key(keyId) },
  });

  return {
    // The public keys first, since they hold the version: a change after it is read makes the
    // commit fail, whichever table it was read from.
    async read() {
      const publicItems = await scan(dynamodb, tables.publicKeys);
      const privateItems = await scan(dynamodb, tables.privateKeys);
      return stateOf(tables, privateItems, publicItems);
    },

    async commit(version, changes) {
      const items: TransactWriteItem[] = [
        ...changes.put.flatMap((key) => [
          put(tables.privateKeys, privateItem(key)),
          put(tables.publicKeys, publicItem(key)),
        ]),
        ...changes.remove.flatMap((keyId) => [
          remove(tables.privateKeys, keyId),
          remove(tables.publicKeys, keyId),
        ]),
        // A revoked key's record takes its item's place in the public keys.
        ...changes.revoke.flatMap((revoked) => [
          remove(tables.privateKeys, revoked.keyId),
          put(tables.publicKeys, revokedItem(revoked)),
        ]),
        ...changes.forget.map((keyId) => remove(tables.publicKeys, keyId)),
        {
          Put: {
            TableName: tables.publicKeys,
            Item: { ...key(VERSION_ITEM), version: { N: String(version + 1) } },
            ...(version === 0
              ? { ConditionExpression: "attribute_not_exists(keyId)" }
              : {
                  ConditionExpression: "version = :seen",
                  ExpressionAttributeValues: {
                    ":seen": { N: String(version) },
                  },
                }),
          },
        },
      ];
      try {
        await dynamodb.send(
          new TransactWriteItemsCommand({
            TransactItems: items,
            // So the SDK's retry of a transaction that went through is answered as the first was,
            // rather than refused for the version it wrote.
            ClientRequestToken: randomUUID(),
          }),
        );
      } catch (error) {
        const reasons =
          error instanceof TransactionCanceledException
            ? (error.CancellationReasons ?? [])
            : [];
        if (reasons.at(-1)?.Code === "ConditionalCheckFailed") {
          throw new Error(
            "The key tables changed since this run read them, so it wrote nothing",
            { cause: error },
          );
        }
        throw error;
      }
    },
  };
}
