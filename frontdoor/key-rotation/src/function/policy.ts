// What differs between kinds of key: what a key is, what KMS binds it to, and how long each lasts.
// Rotation itself is the same for every kind.

import type { DataKeyPairSpec } from "@aws-sdk/client-kms";
import { SIGNING_KEY_PURPOSE } from "@repo/frontdoor-shared";

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
   * How long a revoked key's ID is kept, so a revocation run again, such as by a person who didn't
   * hear that the first succeeded, is answered as done rather than refused.
   */
  readonly revokedKeptMs: number;
}

/**
 * The caller token's keys. A gateway accepts a key only for a token issued while it signs, so a key
 * that has stopped is worth nothing a token's life later, and is kept only until then.
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
};

/** Every kind of key, by the name its tables and config use. */
export const KEY_POLICIES = {
  "caller-token": CALLER_TOKEN_POLICY,
} as const satisfies Record<string, KeyPolicy>;

export type KeyKind = keyof typeof KEY_POLICIES;
