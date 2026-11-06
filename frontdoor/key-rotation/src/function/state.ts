// What key rotation keeps between runs: every key it has made and not yet removed, and the keys
// revoked in the last day, so a revocation that failed part way can be run again.
//
// Each key signs from the time it was scheduled for until the time it stops, which is set when the
// next key is scheduled. The edge signs with it only between the two, and gateways accept it only
// for a token issued between the two. A time that has passed never changes, so a key that has
// stopped signing never signs again, whatever else is revoked.

import { isKeyId, type SigningKey } from "@repo/frontdoor-shared";

export interface StoredKey {
  readonly kid: string;
  /** The public key, as a JWK's `x`: its 32 bytes, base64url. */
  readonly x: string;
  /** The private key as KMS encrypted it, base64. */
  readonly privateKey: string;
  /** When it starts to sign, in seconds since the epoch. */
  readonly signsFrom: number;
  /** When it stops: when the key after it starts. Not set until that key is scheduled. */
  readonly signsUntil?: number;
}

export interface RevokedKey {
  readonly kid: string;
  /** When it was revoked, in seconds since the epoch. */
  readonly revokedAt: number;
}

export interface KeyState {
  readonly keys: readonly StoredKey[];
  readonly revoked: readonly RevokedKey[];
}

export const EMPTY_STATE: KeyState = { keys: [], revoked: [] };

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isStoredKey(value: unknown): value is StoredKey {
  if (typeof value !== "object" || value === null) return false;
  const key = value as Record<string, unknown>;
  return (
    typeof key.kid === "string" &&
    isKeyId(key.kid) &&
    typeof key.x === "string" &&
    BASE64URL.test(key.x) &&
    typeof key.privateKey === "string" &&
    BASE64.test(key.privateKey) &&
    typeof key.signsFrom === "number" &&
    Number.isInteger(key.signsFrom) &&
    (key.signsUntil === undefined ||
      (typeof key.signsUntil === "number" &&
        Number.isInteger(key.signsUntil) &&
        key.signsUntil > key.signsFrom))
  );
}

function isRevokedKey(value: unknown): value is RevokedKey {
  if (typeof value !== "object" || value === null) return false;
  const key = value as Record<string, unknown>;
  return (
    typeof key.kid === "string" &&
    isKeyId(key.kid) &&
    typeof key.revokedAt === "number" &&
    Number.isInteger(key.revokedAt)
  );
}

/** Reads the state parameter's value. A state it can't read stops the run, changing nothing. */
export function parseState(text: string): KeyState {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) {
    throw new Error("The key rotation state is not a key state");
  }
  const { keys, revoked } = value as Record<string, unknown>;
  if (
    !Array.isArray(keys) ||
    !keys.every(isStoredKey) ||
    !Array.isArray(revoked) ||
    !revoked.every(isRevokedKey)
  ) {
    throw new Error("The key rotation state is not a key state");
  }
  return { keys, revoked };
}

const byKid = (a: StoredKey, b: StoredKey) =>
  a.kid < b.kid ? -1 : a.kid > b.kid ? 1 : 0;

/**
 * The public keys every gateway accepts, as a JWK set. Beside each key, the times it signs
 * between, which a gateway holds a token's `iat` to.
 */
export function publicKeySet(state: KeyState): string {
  return JSON.stringify({
    keys: [...state.keys]
      .sort(byKid)
      .map(({ kid, x, signsFrom, signsUntil }) => ({
        kty: "OKP",
        crv: "Ed25519",
        alg: "EdDSA",
        use: "sig",
        kid,
        x,
        signsFrom,
        ...(signsUntil !== undefined && { signsUntil }),
      })),
  });
}

/**
 * The signing key parameter: the keys the edge signs with now or later. A key that has stopped
 * signing is left out, so no edge holds it.
 */
export function signingKeys(state: KeyState, nowSeconds: number): string {
  const keys: SigningKey[] = state.keys
    .filter(
      ({ signsUntil }) => signsUntil === undefined || signsUntil > nowSeconds,
    )
    .sort(byKid)
    .map(({ kid, privateKey, signsFrom }) => ({ kid, privateKey, signsFrom }));
  return JSON.stringify({ keys });
}
