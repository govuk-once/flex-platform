// The caller token: who a request is for, signed by the edge, which a domain passes on to the
// gateways it calls and each gateway verifies.
//
// The edge holds the keys: the one signing now and the one scheduled next, each with the moment it
// starts. It signs with the latest that has started, so every edge switches at the same moment,
// without a read. It reads the keys from SSM in the signing region every five minutes, wherever it
// runs, and decrypts with KMS only a key it doesn't hold yet, so a revocation reaches every edge
// within minutes.

import { createPrivateKey, type KeyObject, sign } from "node:crypto";

import {
  CALLER_TOKEN_TTL_SECONDS,
  parseSigningKeys,
  SIGNING_KEY_PURPOSE,
  type SigningKey,
} from "@repo/frontdoor-shared";

import type { AwsJsonCall } from "./aws-json.ts";

/** How long the edge signs with the keys it holds before reading them again. */
export const SIGNING_KEY_REFRESH_MS = 5 * 60 * 1000;

/** After a failed read, how long the edge goes on with what it has before trying again. */
export const SIGNING_KEY_RETRY_MS = 30 * 1000;

export interface LoadedSigningKey {
  readonly kid: string;
  readonly key: KeyObject;
}

/** The key to sign with now. */
export type LoadSigningKey = () => Promise<LoadedSigningKey>;

interface HeldKey extends LoadedSigningKey {
  readonly signsFrom: number;
}

export interface SigningKeyLoaderOptions {
  readonly call: AwsJsonCall;
  readonly parameterName: string;
  /** Where the parameter and the KMS key are. */
  readonly region: string;
  readonly now?: () => number;
}

/**
 * Loads the keys to sign with, keeps them, and gives the one that signs now. A read that fails
 * keeps the keys the edge has, which hold the next key before it starts; with none that has
 * started, it fails the request, so nothing unsigned is forwarded.
 */
export function createSigningKeyLoader(
  options: SigningKeyLoaderOptions,
): LoadSigningKey {
  const now = options.now ?? Date.now;
  let held: { keys: readonly HeldKey[]; at: number } | undefined;
  let nextAttempt = 0;
  let inFlight: Promise<HeldKey[]> | undefined;

  async function keys(at: number): Promise<readonly HeldKey[]> {
    if (held !== undefined && at - held.at < SIGNING_KEY_REFRESH_MS) {
      return held.keys;
    }
    if (at < nextAttempt) {
      if (held !== undefined) return held.keys;
      throw new Error("No signing key: the last read failed");
    }
    inFlight ??= read(options, held?.keys ?? []).finally(() => {
      inFlight = undefined;
    });
    try {
      const read = await inFlight;
      held = { keys: read, at };
      return read;
    } catch (error) {
      nextAttempt = at + SIGNING_KEY_RETRY_MS;
      if (held !== undefined) return held.keys;
      throw error;
    }
  }

  return async () => {
    const at = now();
    const seconds = Math.floor(at / 1000);
    const signing = (await keys(at))
      .filter(({ signsFrom }) => signsFrom <= seconds)
      .sort((a, b) => b.signsFrom - a.signsFrom)[0];
    if (signing === undefined) throw new Error("No signing key has started");
    return { kid: signing.kid, key: signing.key };
  };
}

async function read(
  { call, parameterName, region }: SigningKeyLoaderOptions,
  held: readonly HeldKey[],
): Promise<HeldKey[]> {
  const parameter = (await call({
    service: "ssm",
    region,
    target: "AmazonSSM.GetParameter",
    body: { Name: parameterName },
  })) as { Parameter?: { Value?: unknown } };
  const value = parameter.Parameter?.Value;
  if (typeof value !== "string") throw new Error("SSM returned no value");

  // A key ID names one key pair, so a key already decrypted is the same key.
  const loaded = new Map(held.map((key) => [key.kid, key.key]));
  return Promise.all(
    parseSigningKeys(value).map(async (signingKey) => ({
      kid: signingKey.kid,
      signsFrom: signingKey.signsFrom,
      key:
        loaded.get(signingKey.kid) ?? (await decrypt(call, region, signingKey)),
    })),
  );
}

async function decrypt(
  call: AwsJsonCall,
  region: string,
  { kid, privateKey }: SigningKey,
): Promise<KeyObject> {
  const decrypted = (await call({
    service: "kms",
    region,
    target: "TrentService.Decrypt",
    body: {
      CiphertextBlob: privateKey,
      // As key rotation made it: a ciphertext decrypts only as the key it was made as.
      EncryptionContext: { purpose: SIGNING_KEY_PURPOSE, kid },
    },
  })) as { Plaintext?: unknown };
  if (typeof decrypted.Plaintext !== "string") {
    throw new Error("KMS returned no key");
  }
  const key = createPrivateKey({
    key: Buffer.from(decrypted.Plaintext, "base64"),
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
    const { kid, key } = await options.loadKey();
    const iat = Math.floor(now() / 1000);
    const input = `${base64url({ alg: "EdDSA", typ: "JWT", kid })}.${base64url({
      pairwiseId,
      service: CALLER_SERVICE,
      aud: options.audience,
      iat,
      exp: iat + CALLER_TOKEN_TTL_SECONDS,
      jti,
    })}`;
    const signature = sign(null, Buffer.from(input), key).toString("base64url");
    return `${input}.${signature}`;
  };
}
