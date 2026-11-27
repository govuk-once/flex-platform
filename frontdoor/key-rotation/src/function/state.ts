// What key rotation keeps between runs, in a kind's two tables: every key it has made and not yet
// removed, and the keys revoked in the last day, so a revocation run again is answered as done.
//
// Each key is used from the time it was scheduled for until the time it stops, which is set when
// the next key is scheduled. A time that has passed never changes, so a key that has stopped is
// never used again, whatever else is revoked.

export interface HeldKey {
  readonly keyId: string;
  /** The public key as KMS returned it: DER, as a SubjectPublicKeyInfo. */
  readonly publicKey: Uint8Array;
  /** The private key as KMS encrypted it. */
  readonly privateKey: Uint8Array;
  /** When it is first used, in seconds since the epoch. */
  readonly activeFrom: number;
  /** When it stops: when the key after it starts. Not set until that key is scheduled. */
  readonly activeUntil?: number;
}

export interface RevokedKey {
  readonly keyId: string;
  /** When it was revoked, in seconds since the epoch. */
  readonly revokedAt: number;
}

export interface KeyState {
  /**
   * How many times the tables have changed: 0 before the first. A change is written only if the
   * tables are still at the version it was worked out from.
   */
  readonly version: number;
  readonly keys: readonly HeldKey[];
  readonly revoked: readonly RevokedKey[];
}

export const EMPTY_STATE: KeyState = { version: 0, keys: [], revoked: [] };

/** What one run changes, written together or not at all. */
export interface KeyChanges {
  /** Keys made, or whose end has changed. Written whole. */
  readonly put: readonly HeldKey[];
  /** Keys removed, by ID, and not revoked in this run. */
  readonly remove: readonly string[];
  /** Keys revoked in this run. Each is no longer held. */
  readonly revoke: readonly RevokedKey[];
  /** Revocations older than rotation keeps, by key ID. */
  readonly forget: readonly string[];
}

/** The changes from one state to the next, or none if the two hold the same. */
export function changesBetween(
  from: KeyState,
  to: Pick<KeyState, "keys" | "revoked">,
): KeyChanges | undefined {
  const held = new Map(from.keys.map((key) => [key.keyId, key]));
  const kept = new Set(to.keys.map(({ keyId }) => keyId));
  const wasRevoked = new Set(from.revoked.map(({ keyId }) => keyId));
  const stillRevoked = new Set(to.revoked.map(({ keyId }) => keyId));

  // A key's other fields never change once it is made.
  const put = to.keys.filter((key) => {
    const before = held.get(key.keyId);
    return before === undefined || before.activeUntil !== key.activeUntil;
  });
  const revoke = to.revoked.filter(({ keyId }) => !wasRevoked.has(keyId));
  const revoking = new Set(revoke.map(({ keyId }) => keyId));
  const remove = from.keys
    .map(({ keyId }) => keyId)
    .filter((keyId) => !kept.has(keyId) && !revoking.has(keyId));
  const forget = from.revoked
    .map(({ keyId }) => keyId)
    .filter((keyId) => !stillRevoked.has(keyId));

  return put.length + remove.length + revoke.length + forget.length === 0
    ? undefined
    : { put, remove, revoke, forget };
}
