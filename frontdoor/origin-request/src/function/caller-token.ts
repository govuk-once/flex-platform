// The caller token: who a request is for, signed by the edge, which a domain passes on to the
// gateways it calls and each gateway verifies.
//
// The edge holds the keys: the one signing now and, from an hour before it starts, the one
// scheduled next. It signs with the latest that has started and not stopped, so every edge switches
// at the same moment, without a read. It reads the keys from the private keys table in the signing
// region every five minutes, wherever it runs, and decrypts with KMS only a key it doesn't hold
// yet, so a revocation reaches every edge within minutes.

import { createPrivateKey, type KeyObject, sign } from "node:crypto";

import {
  type AttributeValue,
  type DynamoDBClient,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { DecryptCommand, type KMSClient } from "@aws-sdk/client-kms";
import {
  CALLER_TOKEN_TTL_SECONDS,
  isKeyId,
  type PrivateKeyItem,
  SIGNING_KEY_PURPOSE,
} from "@repo/frontdoor-shared";
import { keptWhile } from "@repo/utils/kept-while";

import type { DerivePushId } from "./push-id.ts";

/** How long the edge signs with the keys it holds before reading them again. */
export const SIGNING_KEY_REFRESH_MS = 5 * 60 * 1000;

/** After a failed read, how long the edge goes on with what it has before trying again. */
export const SIGNING_KEY_RETRY_MS = 30 * 1000;

/**
 * How long before a key starts the edge decrypts it: many reads, and the least notice key rotation
 * gives. A key is scheduled days ahead, and few instances that see it then live to sign with it.
 */
export const SIGNING_KEY_LEAD_MS = 60 * 60 * 1000;

// One call's whole budget. The function has 10 seconds, and a key load makes at most three calls:
// a read, then a decrypt for each key it doesn't hold yet, at once. The table holds a few small
// items, so a read is one page.
const CALL_TIMEOUT_MS = 1_500;

export interface LoadedSigningKey {
  readonly kid: string;
  readonly key: KeyObject;
}

/** The key to sign with now. */
export type LoadSigningKey = () => Promise<LoadedSigningKey>;

/** A key in the table, as the edge reads it. */
interface StoredKey {
  readonly kid: string;
  readonly privateKey: Uint8Array;
  readonly activeFrom: number;
  readonly activeUntil?: number;
}

interface HeldKey extends LoadedSigningKey {
  readonly activeFrom: number;
  readonly activeUntil?: number;
}

export interface SigningKeyLoaderOptions {
  /** DynamoDB and KMS in the signing region, where the table and the KMS key are. */
  readonly dynamodb: Pick<DynamoDBClient, "send">;
  readonly kms: Pick<KMSClient, "send">;
  /** The caller token's private keys table. */
  readonly tableName: string;
  readonly now?: () => number;
}

const active = (
  { activeFrom, activeUntil }: Pick<StoredKey, "activeFrom" | "activeUntil">,
  seconds: number,
) =>
  activeFrom <= seconds && (activeUntil === undefined || activeUntil > seconds);

/**
 * Loads the keys to sign with, keeps them, and gives the one that signs now. A read that fails
 * keeps the keys the edge has, which hold the next key in its last hour; with none that has
 * started, it fails the request, so nothing unsigned is forwarded.
 */
export function createSigningKeyLoader(
  options: SigningKeyLoaderOptions,
): LoadSigningKey {
  const now = options.now ?? Date.now;
  let nextAttempt = 0;

  // The keys as last read, and when. While it waits to read again, and when a read fails, the
  // load gives back the keys it was given, so the edge goes on with them.
  const keys = keptWhile<{ keys: readonly HeldKey[]; at: number }>(
    async (held) => {
      const at = now();
      if (at < nextAttempt) {
        if (held !== undefined) return held;
        throw new Error("No signing key: the last read failed");
      }
      try {
        return { keys: await read(options, held?.keys ?? [], at), at };
      } catch (error) {
        nextAttempt = at + SIGNING_KEY_RETRY_MS;
        if (held !== undefined) return held;
        throw error;
      }
    },
    ({ at }) => now() - at < SIGNING_KEY_REFRESH_MS,
  );

  return async () => {
    const seconds = Math.floor(now() / 1000);
    const signing = (await keys()).keys
      .filter((key) => active(key, seconds))
      .sort((a, b) => b.activeFrom - a.activeFrom)[0];
    if (signing === undefined) throw new Error("No signing key has started");
    return { kid: signing.kid, key: signing.key };
  };
}

function numberOf(value: AttributeValue | undefined): number | undefined {
  if (value?.N === undefined) return undefined;
  const number = Number(value.N);
  return Number.isSafeInteger(number) ? number : undefined;
}

// The table holds what key rotation writes. Anything else is refused, whole.
function storedKey(
  item: Partial<Record<keyof PrivateKeyItem, AttributeValue>>,
): StoredKey {
  const kid = item.keyId?.S;
  const privateKey = item.privateKey?.B;
  const activeFrom = numberOf(item.activeFrom);
  const activeUntil = numberOf(item.activeUntil);
  if (
    kid === undefined ||
    !isKeyId(kid) ||
    privateKey === undefined ||
    activeFrom === undefined ||
    (item.activeUntil !== undefined &&
      (activeUntil === undefined || activeUntil <= activeFrom))
  ) {
    throw new Error("The private keys table holds something that isn't a key");
  }
  return {
    kid,
    privateKey,
    activeFrom,
    ...(activeUntil !== undefined && { activeUntil }),
  };
}

async function read(
  { dynamodb, kms, tableName }: SigningKeyLoaderOptions,
  held: readonly HeldKey[],
  at: number,
): Promise<HeldKey[]> {
  const { Items, LastEvaluatedKey } = await dynamodb.send(
    new ScanCommand({ TableName: tableName }),
    { abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
  );
  // A page holds a megabyte, thousands of keys. Signing from part of the table could miss the
  // newest key, so a read that would need another page fails.
  if (Items === undefined || LastEvaluatedKey !== undefined) {
    throw new Error("The private keys table answered with more than one page");
  }

  // A key ID names one key pair, so a key already decrypted is the same key.
  const loaded = new Map(held.map((key) => [key.kid, key.key]));
  const seconds = Math.floor(at / 1000);
  const due = Math.floor((at + SIGNING_KEY_LEAD_MS) / 1000);
  return Promise.all(
    Items.map(storedKey)
      // The table also holds keys that have stopped, until rotation removes them.
      .filter(
        ({ activeFrom, activeUntil }) =>
          activeFrom <= due &&
          (activeUntil === undefined || activeUntil > seconds),
      )
      .map(async (stored) => ({
        kid: stored.kid,
        activeFrom: stored.activeFrom,
        ...(stored.activeUntil !== undefined && {
          activeUntil: stored.activeUntil,
        }),
        key: loaded.get(stored.kid) ?? (await decrypt(kms, stored)),
      })),
  );
}

async function decrypt(
  kms: Pick<KMSClient, "send">,
  { kid, privateKey }: StoredKey,
): Promise<KeyObject> {
  const { Plaintext } = await kms.send(
    new DecryptCommand({
      CiphertextBlob: privateKey,
      // As key rotation made it: a ciphertext decrypts only as the key it was made as.
      EncryptionContext: { purpose: SIGNING_KEY_PURPOSE, kid },
    }),
    { abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
  );
  if (Plaintext === undefined) throw new Error("KMS returned no key");
  const key = createPrivateKey({
    key: Buffer.from(Plaintext),
    format: "der",
    type: "pkcs8",
  });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("The signing key is not an Ed25519 key");
  }
  return key;
}

export interface CallerTokenClaims {
  readonly pairwiseId: string;
  /** The request's ID, CloudFront's, so a gateway call traces to the request that made it. */
  readonly jti: string;
}

export type SignCallerToken = (claims: CallerTokenClaims) => Promise<string>;

export interface CallerTokenSignerOptions {
  readonly loadKey: LoadSigningKey;
  /** The caller's push ID, which every token holds: without one, nothing is signed. */
  readonly derivePushId: DerivePushId;
  /** The gateways the token is for, which each checks. */
  readonly audience: string;
  readonly now?: () => number;
}

const base64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * The service the caller uses, whose namespace `pairwiseId` is in: One Login gives each service
 * its own pairwise IDs. The app is the one service the Frontdoor serves.
 */
export const CALLER_SERVICE = "app";

/** Signs a compact JWS: EdDSA, the key's ID, and the caller's values with a minute to live. */
export function createCallerTokenSigner(
  options: CallerTokenSignerOptions,
): SignCallerToken {
  const now = options.now ?? Date.now;
  return async ({ pairwiseId, jti }) => {
    // Together, so a cold start waits for the slower of the two reads, not for both.
    const [{ kid, key }, pushId] = await Promise.all([
      options.loadKey(),
      options.derivePushId(pairwiseId),
    ]);
    const iat = Math.floor(now() / 1000);
    const input = `${base64url({ alg: "EdDSA", typ: "JWT", kid })}.${base64url({
      pairwiseId,
      service: CALLER_SERVICE,
      pushId,
      aud: options.audience,
      iat,
      exp: iat + CALLER_TOKEN_TTL_SECONDS,
      jti,
    })}`;
    const signature = sign(null, Buffer.from(input), key).toString("base64url");
    return `${input}.${signature}`;
  };
}
