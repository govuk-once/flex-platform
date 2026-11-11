// The caller token: who a request is for, signed by the edge, which a domain passes on to the
// gateways it calls and each gateway verifies.
//
// The edge holds the keys: the one signing now and, from an hour before it starts, the one
// scheduled next. It signs with the latest that has started, so every edge switches at the same
// moment, without a read. It reads the keys from SSM in the signing region every five minutes,
// wherever it runs, and decrypts with KMS only a key it doesn't hold yet, so a revocation reaches
// every edge within minutes.

import { createPrivateKey, type KeyObject, sign } from "node:crypto";

import { DecryptCommand, type KMSClient } from "@aws-sdk/client-kms";
import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import {
  CALLER_TOKEN_TTL_SECONDS,
  parseSigningKeys,
  SIGNING_KEY_PURPOSE,
  type SigningKey,
} from "@repo/frontdoor-shared";

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
// a read, then a decrypt for each key it doesn't hold yet, at once.
const CALL_TIMEOUT_MS = 1_500;

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
  /** SSM and KMS in the signing region, where the parameter and the KMS key are. */
  readonly ssm: Pick<SSMClient, "send">;
  readonly kms: Pick<KMSClient, "send">;
  readonly parameterName: string;
  readonly now?: () => number;
}

/**
 * Loads the keys to sign with, keeps them, and gives the one that signs now. A read that fails
 * keeps the keys the edge has, which hold the next key in its last hour; with none that has
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
    inFlight ??= read(options, held?.keys ?? [], at).finally(() => {
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
  { ssm, kms, parameterName }: SigningKeyLoaderOptions,
  held: readonly HeldKey[],
  at: number,
): Promise<HeldKey[]> {
  const { Parameter } = await ssm.send(
    new GetParameterCommand({ Name: parameterName }),
    { abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
  );
  const value = Parameter?.Value;
  if (value === undefined) throw new Error("SSM returned no value");

  // A key ID names one key pair, so a key already decrypted is the same key.
  const loaded = new Map(held.map((key) => [key.kid, key.key]));
  const due = Math.floor((at + SIGNING_KEY_LEAD_MS) / 1000);
  return Promise.all(
    parseSigningKeys(value)
      .filter(({ signsFrom }) => signsFrom <= due)
      .map(async (signingKey) => ({
        kid: signingKey.kid,
        signsFrom: signingKey.signsFrom,
        key: loaded.get(signingKey.kid) ?? (await decrypt(kms, signingKey)),
      })),
  );
}

async function decrypt(
  kms: Pick<KMSClient, "send">,
  { kid, privateKey }: SigningKey,
): Promise<KeyObject> {
  const { Plaintext } = await kms.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(privateKey, "base64"),
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
