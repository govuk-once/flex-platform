// What differs between kinds of key: what a key is, what KMS binds it to, how long each lasts, and
// what is published of them. Rotation itself is the same for every kind.

import { createPublicKey } from "node:crypto";

import type { DataKeyPairSpec } from "@aws-sdk/client-kms";
import { SIGNING_KEY_PURPOSE } from "@repo/frontdoor-shared";

import type { HeldKey } from "./state.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export interface KeyPolicy {
  /** The key pair KMS makes. */
  readonly keyPairSpec: DataKeyPairSpec;
  /**
   * The encryption context's `purpose`, which every private key is bound to, beside its key ID. A
   * role may be given decryption for one purpose alone.
   */
  readonly purpose: string;
  /** How long a key is used before the next replaces it. */
  readonly periodMs: number;
  /**
   * The least time between making a key and its first use: longer than a reader goes between reads
   * of the keys, with every run until then to retry a failed write. Normally a key is made a whole
   * period ahead.
   */
  readonly minimumLeadMs: number;
  /** How long a key is kept after it stops. */
  readonly retiredKeptMs: number;
  /**
   * How long a revoked key's ID is kept, so a revocation whose writes failed part way can be run
   * again. Every run writes what each reader should hold, so by then many runs have finished it.
   */
  readonly revokedKeptMs: number;
  /**
   * The document the kind publishes its public keys in, from every key rotation holds, or null for
   * a kind that publishes none. It fails for a key it can't publish, before anything is written.
   */
  readonly publication: ((keys: readonly HeldKey[]) => string) | null;
}

function byKeyId(a: HeldKey, b: HeldKey): number {
  if (a.keyId < b.keyId) return -1;
  return a.keyId > b.keyId ? 1 : 0;
}

/**
 * The public keys every gateway accepts, as a JWK set. Beside each key, the times it signs
 * between, which a gateway holds a token's `iat` to. Gateways read this object as it is, so its
 * name, shape and field names never change.
 */
export function callerTokenKeySet(keys: readonly HeldKey[]): string {
  return JSON.stringify({
    keys: [...keys]
      .sort(byKeyId)
      .map(({ keyId, publicKey, activeFrom, activeUntil }) => {
        const { crv, x } = createPublicKey({
          key: Buffer.from(publicKey),
          format: "der",
          type: "spki",
        }).export({ format: "jwk" });
        if (crv !== "Ed25519" || x === undefined) {
          throw new Error(`The key ${keyId} is not an Ed25519 key`);
        }
        return {
          kty: "OKP",
          crv: "Ed25519",
          alg: "EdDSA",
          use: "sig",
          kid: keyId,
          x,
          signsFrom: activeFrom,
          ...(activeUntil !== undefined && { signsUntil: activeUntil }),
        };
      }),
  });
}

/**
 * The caller token's keys. A gateway accepts a key only for a token issued while it signs, so a key
 * that has stopped is worth nothing a token's life later, and is published only until then.
 */
export const CALLER_TOKEN_POLICY: KeyPolicy = {
  keyPairSpec: "ECC_NIST_EDWARDS25519",
  purpose: SIGNING_KEY_PURPOSE,
  periodMs: 7 * 24 * HOUR,
  // Longer than an edge goes between reads of its keys, and than a gateway keeps the public keys.
  minimumLeadMs: HOUR,
  // A token's life, with room to spare.
  retiredKeptMs: 5 * MINUTE,
  revokedKeptMs: 24 * HOUR,
  publication: callerTokenKeySet,
};

/** Every kind of key, by the name its tables and config use. */
export const KEY_POLICIES = {
  "caller-token": CALLER_TOKEN_POLICY,
} as const satisfies Record<string, KeyPolicy>;

export type KeyKind = keyof typeof KEY_POLICIES;
