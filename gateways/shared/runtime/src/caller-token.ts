// Verifies the caller token: who a call is for, signed by the edge, which the domain passes on
// unchanged. Its claims are what an operation's secure bindings compare the input with.
//
// The token is a compact JWS, EdDSA over Ed25519 and nothing else. The keys are the edge's public
// keys, which key rotation keeps in a table in the frontdoor account. The gateway reads the table
// whole and keeps the keys for a minute, so a revoked key is refused within a minute. A key ID the
// gateway hasn't seen reads them again, but not more than once every ten seconds, so a caller can't
// make every call read them.
//
// Each key comes with the times it signs between, and verifies only a token issued in them. So a
// key made ahead of its time verifies nothing yet, and a key that has been replaced verifies
// nothing a token's life after, whether or not it has been removed.

import { createPublicKey, type KeyObject, verify } from "node:crypto";

import {
  type AttributeValue,
  DynamoDBClient,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { isCanonicalBase64url } from "@repo/cloudfront-js-utils/is-canonical-base64url";
import { jwtSegmentObject } from "@repo/cloudfront-js-utils/jwt-segment-object";
import { SECURE_CLAIMS, type SecureClaims } from "@repo/gateway-core";
import { ownValue } from "@repo/utils/own-value";
import { type Env, requiredEnv } from "@repo/utils/required-env";

import { AWS_REQUEST_HANDLER } from "./aws-request-handler.ts";
import { GatewayError } from "./errors.ts";
import { readGatewayRegion } from "./upstream-target.ts";

export const CALLER_TOKEN_KEYS_TABLE_ENV = "FLEX_CALLER_TOKEN_KEYS_TABLE";
export const CALLER_TOKEN_KEYS_ENDPOINT_ENV = "FLEX_CALLER_TOKEN_KEYS_ENDPOINT";
export const CALLER_TOKEN_AUDIENCE_ENV = "FLEX_CALLER_TOKEN_AUDIENCE";

/** How long the gateway keeps the public keys before reading them again. */
export const KEYS_MAX_AGE_MS = 60 * 1000;

/** The least time between two reads of the public keys, whether or not the last one worked. */
export const KEYS_MIN_INTERVAL_MS = 10 * 1000;

/**
 * How long the gateway goes on with the keys it has while reads fail. A key revoked in that time is
 * one it can't know of, so after this it refuses every token until a read works. It bounds how long
 * a revoked key can be accepted while reads fail, and leaves room for a failed read to be retried
 * many times before any call fails.
 */
export const KEYS_MAX_STALE_MS = 5 * 60 * 1000;

/** How far the gateway's clock may be from the edge's. */
export const CLOCK_TOLERANCE_SECONDS = 5;

/** The edge signs a token for a minute. One that claims longer was not signed as the edge signs. */
export const MAX_LIFETIME_SECONDS = 60;

// A token is a few hundred characters. Anything far longer isn't one, and isn't decoded.
const MAX_TOKEN_LENGTH = 4096;

// RFC 8032 fixes the length.
const ED25519_SIGNATURE_BYTES = 64;

// The item key rotation keeps its count of changes in, beside the keys.
const VERSION_ITEM = "#version";

// The UTC time the key was made, as key rotation names keys, such as `20261106T120000Z`.
const KEY_ID = /^\d{8}T\d{6}Z$/;

// CloudFront's request IDs, which the edge signs as `jti`, and the gateway logs.
const TOKEN_ID = /^[A-Za-z0-9_=-]{1,128}$/;

export interface VerifiedCaller {
  readonly claims: SecureClaims;
  /** The token's `jti`: CloudFront's ID for the request that made the call. */
  readonly tokenId: string;
}

/** Where a read of the keys that failed is logged: the gateway's own logger. */
export interface KeyReadLog {
  warn(fields: object, message: string): void;
}

export type VerifyCallerToken = (
  token: string | undefined,
  log?: KeyReadLog,
) => Promise<VerifiedCaller>;

/** One of the edge's public keys, and the times it signs between, in seconds since the epoch. */
export interface CallerTokenKey {
  readonly key: KeyObject;
  readonly signsFrom: number;
  /** Absent until the key that replaces it is scheduled. */
  readonly signsUntil?: number;
}

/** The edge's public keys, by key ID. A read made for the call that fails is logged to `log`. */
export interface CallerTokenKeys {
  get(kid: string, log?: KeyReadLog): Promise<CallerTokenKey | undefined>;
}

export interface CallerTokenVerifierOptions {
  readonly keys: CallerTokenKeys;
  /** The `aud` this environment's edge signs, which the token must name exactly. */
  readonly audience: string;
  readonly now?: () => number;
}

// The message names the check that failed, never a value from the token.
function invalid(check: string): GatewayError {
  return new GatewayError(
    "SECURE_SIGNATURE_INVALID",
    `Caller token refused: ${check}`,
  );
}

// Base64url as every encoder writes it, so one token has one form.
function decodeSegment(segment: string): Buffer | undefined {
  return isCanonicalBase64url(segment)
    ? Buffer.from(segment, "base64url")
    : undefined;
}

interface CompactJws {
  readonly header: string;
  readonly payload: string;
  readonly signature: string;
}

function splitToken(token: string | undefined): CompactJws {
  // A domain that forgot the token, not one that tampered with it.
  if (token === undefined || token.length === 0) {
    throw new GatewayError(
      "UNAUTHENTICATED",
      "The call carries no caller token",
    );
  }
  if (token.length > MAX_TOKEN_LENGTH) throw invalid("too long");

  const segments = token.split(".");
  if (segments.length !== 3) throw invalid("not a compact JWS");
  const [header = "", payload = "", signature = ""] = segments;

  return { header, payload, signature };
}

function readKeyId(encodedHeader: string): string {
  const header = jwtSegmentObject(encodedHeader);
  if (header === undefined) throw invalid("header");
  // Pinned: the header never chooses how the token is checked.
  if (ownValue(header, "alg") !== "EdDSA") throw invalid("algorithm");
  if (ownValue(header, "crit") !== undefined) throw invalid("critical header");

  const kid = ownValue(header, "kid");
  // Checked before it is looked up, since a caller chose it.
  if (typeof kid !== "string" || !KEY_ID.test(kid)) throw invalid("key ID");

  return kid;
}

function checkTimes(
  payload: Record<string, unknown>,
  key: CallerTokenKey,
  seconds: number,
): void {
  const iat = ownValue(payload, "iat");
  const exp = ownValue(payload, "exp");
  if (typeof iat !== "number" || typeof exp !== "number") {
    throw invalid("times");
  }
  if (exp - iat > MAX_LIFETIME_SECONDS) throw invalid("lifetime");
  if (iat > seconds + CLOCK_TOLERANCE_SECONDS) throw invalid("issued later");
  if (exp <= seconds - CLOCK_TOLERANCE_SECONDS) throw invalid("expired");
  // Issued while the key signed. The edge switches keys at the moment the next starts.
  if (iat < key.signsFrom - CLOCK_TOLERANCE_SECONDS) {
    throw invalid("key not yet signing");
  }
  if (
    key.signsUntil !== undefined &&
    iat > key.signsUntil + CLOCK_TOLERANCE_SECONDS
  ) {
    throw invalid("key replaced");
  }
}

function readCaller(payload: Record<string, unknown>): VerifiedCaller {
  const tokenId = ownValue(payload, "jti");
  if (typeof tokenId !== "string" || !TOKEN_ID.test(tokenId)) {
    throw invalid("token ID");
  }

  const claims: Record<string, string> = {};
  for (const claim of SECURE_CLAIMS) {
    const value = ownValue(payload, claim);
    if (typeof value !== "string" || value.length === 0) {
      throw invalid(`claim ${claim}`);
    }
    claims[claim] = value;
  }

  return { claims: claims as SecureClaims, tokenId };
}

export function createCallerTokenVerifier(
  options: CallerTokenVerifierOptions,
): VerifyCallerToken {
  const now = options.now ?? Date.now;

  return async (token, log) => {
    const jws = splitToken(token);
    const kid = readKeyId(jws.header);

    const signature = decodeSegment(jws.signature);
    if (signature?.length !== ED25519_SIGNATURE_BYTES)
      throw invalid("signature");

    const key = await options.keys.get(kid, log);
    if (key === undefined) throw invalid("unknown key");

    const signed = Buffer.from(`${jws.header}.${jws.payload}`);
    if (!verify(null, signed, key.key, signature)) throw invalid("signature");

    const payload = jwtSegmentObject(jws.payload);
    if (payload === undefined) throw invalid("payload");
    if (ownValue(payload, "aud") !== options.audience)
      throw invalid("audience");

    checkTimes(payload, key, now() / 1000);

    return readCaller(payload);
  };
}

/** One item of the public keys table, as DynamoDB gives it. */
export type KeyItem = Readonly<Record<string, AttributeValue>>;

export interface CallerTokenKeysOptions {
  /** Reads every item of the public keys table. */
  readonly read: () => Promise<readonly KeyItem[]>;
  readonly now?: () => number;
}

const seconds = (value: AttributeValue | undefined): number | undefined => {
  if (value?.N === undefined) return undefined;
  const number = Number(value.N);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
};

// The public key as KMS made it: DER, as a SubjectPublicKeyInfo. Anything but Ed25519 is refused.
function ed25519Key(der: Uint8Array): KeyObject | undefined {
  try {
    const key = createPublicKey({
      key: Buffer.from(der),
      format: "der",
      type: "spki",
    });
    return key.asymmetricKeyType === "ed25519" ? key : undefined;
  } catch {
    return undefined;
  }
}

// Why the gateway itself refused what a read gave it. Each is fixed, and says nothing of the item.
type KeysRefusal =
  | "item_without_key_id"
  | "item_not_a_key"
  | "revoked_item_with_key"
  | "more_than_one_page";

class KeysRefused extends Error {
  constructor(readonly reason: KeysRefusal) {
    super(`The caller token's keys were refused: ${reason}`);
  }
}

// AWS's names for its errors, such as AccessDeniedException. No refusal of the gateway's own has
// this shape, so one is never read as the other.
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

// Why a read failed, as a log may say it: the gateway's own reason, or the error's name, which
// for an answer from DynamoDB is AWS's code for it. Never the message, which can hold what the
// store sent, and never anything of an item.
function readFailure(error: unknown): string {
  if (error instanceof KeysRefused) return error.reason;
  return error instanceof Error && ERROR_NAME.test(error.name)
    ? error.name
    : "unnamed_error";
}

// The table as key rotation writes it: a key's item gives the key and the times it signs between.
// A revoked key's record and the version item hold no key, and are passed over. Anything else
// refuses the read whole: the table was not written as rotation writes it. So does a revoked key's
// record that holds a key, as rotation's own read of it does: it is one or the other.
function parseKeyItems(items: readonly KeyItem[]): Map<string, CallerTokenKey> {
  const parsed = new Map<string, CallerTokenKey>();
  for (const item of items) {
    const kid = item.keyId?.S;
    if (kid === VERSION_ITEM) continue;
    if (kid === undefined || !KEY_ID.test(kid)) {
      throw new KeysRefused("item_without_key_id");
    }
    if (item.revokedAt !== undefined) {
      if (item.publicKey !== undefined) {
        throw new KeysRefused("revoked_item_with_key");
      }
      continue;
    }
    const publicKey = item.publicKey?.B;
    const key = publicKey === undefined ? undefined : ed25519Key(publicKey);
    const signsFrom = seconds(item.activeFrom);
    const signsUntil = seconds(item.activeUntil);
    if (
      key === undefined ||
      signsFrom === undefined ||
      (item.activeUntil !== undefined &&
        (signsUntil === undefined || signsUntil <= signsFrom))
    ) {
      throw new KeysRefused("item_not_a_key");
    }
    parsed.set(kid, {
      key,
      signsFrom,
      ...(signsUntil !== undefined && { signsUntil }),
    });
  }
  return parsed;
}

/**
 * Reads every item of the table, in one page. A table that needs another isn't one rotation
 * keeps, which is a few keys, so the read fails rather than go on page by page.
 */
export function scanKeyTable(
  dynamodb: Pick<DynamoDBClient, "send">,
  table: string,
): () => Promise<readonly KeyItem[]> {
  return async () => {
    const { Items, LastEvaluatedKey } = await dynamodb.send(
      new ScanCommand({ TableName: table }),
    );
    if (Items === undefined || LastEvaluatedKey !== undefined) {
      throw new KeysRefused("more_than_one_page");
    }
    return Items;
  };
}

/**
 * The public keys, read once, kept for a minute, and read again sooner for a key ID they don't
 * hold, but never more than once in ten seconds. A read that fails keeps the keys the gateway has,
 * for five minutes from the last read that worked. With none, the call fails as INTERNAL, since
 * a caller can't have caused it. Each read that fails is logged, with why, so a table the gateway
 * can't read shows before any call fails.
 */
export function createCallerTokenKeys(
  options: CallerTokenKeysOptions,
): CallerTokenKeys {
  const now = options.now ?? Date.now;
  let keys: Map<string, CallerTokenKey> | undefined;
  let readAt = Number.NEGATIVE_INFINITY;
  let triedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | undefined;

  async function refresh(at: number, log?: KeyReadLog): Promise<void> {
    triedAt = at;
    try {
      keys = parseKeyItems(await options.read());
      readAt = at;
    } catch (error) {
      // Neither the store's error nor the item that failed to parse is kept: the log says why
      // in a word. Logging never fails the call, which goes on with the keys it has.
      try {
        log?.warn(
          { reason: readFailure(error) },
          "The caller token's keys could not be read",
        );
      } catch {
        // The call is answered either way.
      }
    }
  }

  return {
    async get(kid, log) {
      const at = now();
      const due =
        keys === undefined || at - readAt >= KEYS_MAX_AGE_MS || !keys.has(kid);
      if (due && at - triedAt >= KEYS_MIN_INTERVAL_MS) {
        // Logged through the call that started it, whichever calls then share it.
        inFlight ??= refresh(at, log).finally(() => {
          inFlight = undefined;
        });
      }
      // A call that needs a read waits for the one under way, whoever started it.
      if (due && inFlight !== undefined) await inFlight;
      // The read may have taken long enough to pass the limit, so the clock is read again.
      if (keys === undefined || now() - readAt >= KEYS_MAX_STALE_MS) {
        throw new GatewayError(
          "INTERNAL",
          "The caller token's keys could not be read",
        );
      }
      return keys.get(kid);
    },
  };
}

// A DynamoDB table's ARN, which names its region and account: the table is in the frontdoor's.
const TABLE_ARN =
  /^arn:aws[a-z-]*:dynamodb:([a-z0-9-]+):\d{12}:table\/[A-Za-z0-9_.-]{3,255}$/;

function tableArn(env: Env, region: string): string {
  const arn = requiredEnv(CALLER_TOKEN_KEYS_TABLE_ENV, env);
  const match = TABLE_ARN.exec(arn);
  if (match === null) {
    throw new Error(
      `Environment variable ${CALLER_TOKEN_KEYS_TABLE_ENV} must be a DynamoDB table's ARN`,
    );
  }
  // The endpoint reaches its own region's tables alone.
  if (match[1] !== region) {
    throw new Error(
      `Environment variable ${CALLER_TOKEN_KEYS_TABLE_ENV} must name a table in ${region}`,
    );
  }
  return arn;
}

// A hostname alone: no scheme, port or path. The gateway always calls it over HTTPS.
const HOSTNAME = /^(?:(?!-)[a-z0-9-]{1,63}(?<!-)\.)+[a-z][a-z0-9-]{0,62}$/;

function endpointUrl(env: Env): string {
  const name = requiredEnv(CALLER_TOKEN_KEYS_ENDPOINT_ENV, env);
  if (!HOSTNAME.test(name)) {
    throw new Error(
      `Environment variable ${CALLER_TOKEN_KEYS_ENDPOINT_ENV} must be an endpoint's name`,
    );
  }
  return `https://${name}`;
}

/**
 * The verifier as deployed: the keys from the table the deployment names by ARN, in the frontdoor
 * account, and the audience it names. Nothing is read until the first call.
 *
 * DynamoDB's interface endpoint has no private DNS, so the SDK's usual name for DynamoDB doesn't
 * reach it, and the DNS allowlist refuses it. Every read goes to the endpoint's own name instead.
 */
export function readCallerTokenVerifier(
  env: Env = process.env,
): VerifyCallerToken {
  const region = readGatewayRegion(env);
  const table = tableArn(env, region);
  const endpoint = endpointUrl(env);
  const audience = requiredEnv(CALLER_TOKEN_AUDIENCE_ENV, env);
  const dynamodb = new DynamoDBClient({
    region,
    endpoint,
    requestHandler: AWS_REQUEST_HANDLER,
  });
  return createCallerTokenVerifier({
    audience,
    keys: createCallerTokenKeys({ read: scanKeyTable(dynamodb, table) }),
  });
}
