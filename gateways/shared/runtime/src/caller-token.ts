// Verifies the caller token: who a call is for, signed by the edge, which the domain passes on
// unchanged. Its claims are what an operation's secure bindings compare the input with.
//
// The token is a compact JWS, EdDSA over Ed25519 and nothing else. The keys are the edge's public
// keys, which key rotation writes to one object in the frontdoor account, read from S3 and kept for
// a minute, so a revoked key is refused within a minute. A key ID the gateway hasn't seen reads
// them again, but not more than once every ten seconds, so a caller can't make every call read
// them.
//
// Each key comes with the times it signs between, and verifies only a token issued in them. So a
// key published ahead of its time verifies nothing yet, and a key that has been replaced verifies
// nothing a token's life after, whether or not it has been removed.

import { createPublicKey, type KeyObject, verify } from "node:crypto";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SECURE_CLAIMS, type SecureClaims } from "@repo/gateway-core";
import { isRecord } from "@repo/utils/is-record";

import { GatewayError } from "./errors.ts";
import { readGatewayRegion } from "./upstream-target.ts";

export const CALLER_TOKEN_KEYS_BUCKET_ENV = "FLEX_CALLER_TOKEN_KEYS_BUCKET";
export const CALLER_TOKEN_KEYS_OBJECT_ENV = "FLEX_CALLER_TOKEN_KEYS_OBJECT";
export const CALLER_TOKEN_KEYS_ACCOUNT_ENV = "FLEX_CALLER_TOKEN_KEYS_ACCOUNT";
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

const BASE64URL = /^[A-Za-z0-9_-]+$/;

// The only key the edge publishes, and the only one a gateway takes. A key is built from this and
// its checked `x` alone, so nothing else the key set holds reaches it.
const ED25519_JWK = { kty: "OKP", crv: "Ed25519" } as const;

// RFC 8032 fixes both lengths.
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

// The UTC time the key was made, as key rotation names keys, such as `20261106T120000Z`.
const KEY_ID = /^\d{8}T\d{6}Z$/;

// CloudFront's request IDs, which the edge signs as `jti`, and the gateway logs.
const TOKEN_ID = /^[A-Za-z0-9_=-]{1,128}$/;

export interface VerifiedCaller {
  readonly claims: SecureClaims;
  /** The token's `jti`: CloudFront's ID for the request that made the call. */
  readonly tokenId: string;
}

export type VerifyCallerToken = (
  token: string | undefined,
) => Promise<VerifiedCaller>;

/** One of the edge's public keys, and the times it signs between, in seconds since the epoch. */
export interface CallerTokenKey {
  readonly key: KeyObject;
  readonly signsFrom: number;
  /** Absent until the key that replaces it is scheduled. */
  readonly signsUntil?: number;
}

/** The edge's public keys, by key ID. */
export interface CallerTokenKeys {
  get(kid: string): Promise<CallerTokenKey | undefined>;
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
  if (!BASE64URL.test(segment)) return undefined;
  const bytes = Buffer.from(segment, "base64url");
  return bytes.toString("base64url") === segment ? bytes : undefined;
}

function decodeJson(segment: string): Record<string, unknown> | undefined {
  const bytes = decodeSegment(segment);
  if (bytes === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// Own properties only: every value came from JSON.parse, so Object.prototype is behind it.
function own(record: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

export function createCallerTokenVerifier(
  options: CallerTokenVerifierOptions,
): VerifyCallerToken {
  const now = options.now ?? Date.now;

  return async (token) => {
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
    const [encodedHeader = "", encodedPayload = "", encodedSignature = ""] =
      segments;

    const header = decodeJson(encodedHeader);
    if (header === undefined) throw invalid("header");
    // Pinned: the header never chooses how the token is checked.
    if (own(header, "alg") !== "EdDSA") throw invalid("algorithm");
    if (own(header, "crit") !== undefined) throw invalid("critical header");
    const kid = own(header, "kid");
    // Checked before it is looked up, since a caller chose it.
    if (typeof kid !== "string" || !KEY_ID.test(kid)) throw invalid("key ID");

    const signature = decodeSegment(encodedSignature);
    if (signature?.length !== ED25519_SIGNATURE_BYTES)
      throw invalid("signature");

    const key = await options.keys.get(kid);
    if (key === undefined) throw invalid("unknown key");
    if (
      !verify(
        null,
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        key.key,
        signature,
      )
    ) {
      throw invalid("signature");
    }

    const payload = decodeJson(encodedPayload);
    if (payload === undefined) throw invalid("payload");
    if (own(payload, "aud") !== options.audience) throw invalid("audience");

    const seconds = now() / 1000;
    const iat = own(payload, "iat");
    const exp = own(payload, "exp");
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

    const tokenId = own(payload, "jti");
    if (typeof tokenId !== "string" || !TOKEN_ID.test(tokenId)) {
      throw invalid("token ID");
    }

    const claims: Record<string, string> = {};
    for (const claim of SECURE_CLAIMS) {
      const value = own(payload, claim);
      if (typeof value !== "string" || value.length === 0) {
        throw invalid(`claim ${claim}`);
      }
      claims[claim] = value;
    }
    return { claims: claims as SecureClaims, tokenId };
  };
}

export interface CallerTokenKeysOptions {
  /** Reads the public keys, as a JWK set's JSON. */
  readonly read: () => Promise<string>;
  readonly now?: () => number;
}

const isSeconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// The JWK set key rotation writes, each key with the times it signs between. A set with any key
// the gateway can't use is refused whole: it was not written as rotation writes it.
function parseKeySet(text: string): Map<string, CallerTokenKey> {
  const value: unknown = JSON.parse(text);
  const keys = isRecord(value) ? own(value, "keys") : undefined;
  if (!Array.isArray(keys)) throw new Error("not a JWK set");
  const parsed = new Map<string, CallerTokenKey>();
  for (const jwk of keys) {
    if (!isRecord(jwk)) throw new Error("a key is not an object");
    const kid = own(jwk, "kid");
    const x = own(jwk, "x");
    const signsFrom = own(jwk, "signsFrom");
    const signsUntil = own(jwk, "signsUntil");
    if (
      typeof kid !== "string" ||
      !KEY_ID.test(kid) ||
      own(jwk, "kty") !== ED25519_JWK.kty ||
      own(jwk, "crv") !== ED25519_JWK.crv ||
      typeof x !== "string" ||
      decodeSegment(x)?.length !== ED25519_PUBLIC_KEY_BYTES ||
      !isSeconds(signsFrom) ||
      (signsUntil !== undefined &&
        (!isSeconds(signsUntil) || signsUntil <= signsFrom))
    ) {
      throw new Error("a key is not an Ed25519 public key with its times");
    }
    parsed.set(kid, {
      key: createPublicKey({
        key: { ...ED25519_JWK, x },
        format: "jwk",
      }),
      signsFrom,
      ...(signsUntil !== undefined && { signsUntil }),
    });
  }
  return parsed;
}

/**
 * The public keys, read once, kept for a minute, and read again sooner for a key ID they don't
 * hold, but never more than once in ten seconds. A read that fails keeps the keys the gateway has,
 * for five minutes from the last read that worked. With none, the call fails as INTERNAL, since
 * a caller can't have caused it.
 */
export function createCallerTokenKeys(
  options: CallerTokenKeysOptions,
): CallerTokenKeys {
  const now = options.now ?? Date.now;
  let keys: Map<string, CallerTokenKey> | undefined;
  let readAt = Number.NEGATIVE_INFINITY;
  let triedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | undefined;

  async function refresh(at: number): Promise<void> {
    triedAt = at;
    try {
      keys = parseKeySet(await options.read());
      readAt = at;
    } catch {
      // Neither the store's error nor the text that failed to parse is kept.
    }
  }

  return {
    async get(kid) {
      const at = now();
      const due =
        keys === undefined || at - readAt >= KEYS_MAX_AGE_MS || !keys.has(kid);
      if (due && at - triedAt >= KEYS_MIN_INTERVAL_MS) {
        inFlight ??= refresh(at).finally(() => {
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

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Environment variable ${name} must be set`);
  }
  return value;
}

const ACCOUNT_ID = /^\d{12}$/;

/**
 * The verifier as deployed: the keys from the S3 object the deployment names, in a bucket in the
 * gateway's region, and the audience it names. Nothing is read until the first call.
 *
 * Every read names the account that owns the bucket. Bucket names are global, so without it a
 * bucket of the same name in another account, made before the frontdoor's or after it is gone,
 * would be read, and its keys trusted.
 */
export function readCallerTokenVerifier(
  env: Env = process.env,
): VerifyCallerToken {
  const bucket = required(env, CALLER_TOKEN_KEYS_BUCKET_ENV);
  const object = required(env, CALLER_TOKEN_KEYS_OBJECT_ENV);
  const owner = required(env, CALLER_TOKEN_KEYS_ACCOUNT_ENV);
  if (!ACCOUNT_ID.test(owner)) {
    throw new Error(
      `Environment variable ${CALLER_TOKEN_KEYS_ACCOUNT_ENV} must be an AWS account ID`,
    );
  }
  const audience = required(env, CALLER_TOKEN_AUDIENCE_ENV);
  const s3 = new S3Client({
    region: readGatewayRegion(env),
    requestHandler: {
      connectionTimeout: 2_000,
      requestTimeout: 5_000,
      throwOnRequestTimeout: true,
    },
  });
  return createCallerTokenVerifier({
    audience,
    keys: createCallerTokenKeys({
      async read() {
        const { Body } = await s3.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: object,
            ExpectedBucketOwner: owner,
          }),
        );
        if (Body === undefined) throw new Error("no body");
        return Body.transformToString("utf8");
      },
    }),
  });
}
