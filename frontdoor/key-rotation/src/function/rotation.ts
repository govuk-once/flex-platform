// One run of key rotation, for one kind of key. It is safe to run at any time, as often as the
// schedule likes: each run does what is due and nothing else.
//
// A switch from one key to the next is a time, set when the next key is made, a period ahead, and
// kept as the time the current key stops. Readers hold both keys before then, so every reader
// switches at that moment without a read.

import { keyIdFor } from "@repo/frontdoor-shared";

import type { KeyPolicy } from "./policy.ts";
import {
  changesBetween,
  type HeldKey,
  type KeyChanges,
  type KeyState,
} from "./state.ts";

export interface GeneratedKey {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

/** What a run does to AWS, so the run itself is plain logic. */
export interface RotationPorts {
  /** Reads the tables, and the version they are at. */
  read(): Promise<KeyState>;
  /**
   * Writes the changes to both tables in one transaction, only if they are still at `version`. A
   * commit that fails writes nothing.
   */
  commit(version: number, changes: KeyChanges): Promise<void>;
  /** Makes a key pair, its private key encrypted for the kind's readers. */
  generate(keyId: string): Promise<GeneratedKey>;
  /** Fails unless KMS can decrypt the private key, as a reader will ask it to. */
  check(key: Pick<HeldKey, "keyId" | "privateKey">): Promise<void>;
}

export interface RotationRequest {
  /**
   * A key to remove at once, whatever it is doing. If it was in use, a new one is used straight
   * away. If it was scheduled, another is scheduled, at least the least lead ahead.
   */
  readonly revoke?: string;
}

export type RotationEventName =
  "key_generated" | "key_pruned" | "key_revoked" | "key_already_revoked";

export interface RotationEvent {
  readonly event: RotationEventName;
  readonly keyId: string;
  /** For a key made, when it is first used, in seconds since the epoch. */
  readonly activeFrom?: number;
}

/** A key KMS wouldn't decrypt when a run checked it. */
export class KeyCheckFailed extends Error {
  constructor(
    readonly keyId: string,
    /** AWS's name for the error, such as InvalidCiphertextException. */
    readonly reason: string,
    /** Whether rotation held the key before this run. It passed this check when it was made. */
    readonly stored: boolean,
    cause: unknown,
  ) {
    super(`The key ${keyId} failed its check: ${reason}`, { cause });
  }
}

export interface RotationReport {
  readonly events: readonly RotationEvent[];
}

const seconds = (ms: number) => Math.floor(ms / 1000);

const withoutEnd = ({
  keyId,
  publicKey,
  privateKey,
  activeFrom,
}: HeldKey): HeldKey => ({ keyId, publicKey, privateKey, activeFrom });

export async function rotate(
  ports: RotationPorts,
  policy: KeyPolicy,
  now: Date,
  request: RotationRequest = {},
): Promise<RotationReport> {
  const events: RotationEvent[] = [];
  const nowSeconds = seconds(now.getTime());
  const state = await ports.read();
  let keys = [...state.keys];
  let revokedKeys = [...state.revoked];

  const revoked = keys.find(({ keyId }) => keyId === request.revoke);
  if (request.revoke !== undefined && revoked === undefined) {
    if (!revokedKeys.some(({ keyId }) => keyId === request.revoke)) {
      throw new Error("The key to revoke is not one rotation holds");
    }
    // Run again, such as by a person who didn't hear that the first succeeded: the rest of the run
    // does whatever else is due.
    events.push({ event: "key_already_revoked", keyId: request.revoke });
  }
  if (revoked !== undefined) {
    // The key that was to hand over to a scheduled key no longer stops then, and is given a new
    // end below. An end that has passed stays, so the key before a revoked key in use is never
    // used again.
    keys = keys
      .filter((key) => key !== revoked)
      .map((key) =>
        key.activeUntil === revoked.activeFrom && key.activeUntil > nowSeconds
          ? withoutEnd(key)
          : key,
      );
    revokedKeys.push({ keyId: revoked.keyId, revokedAt: nowSeconds });
    events.push({ event: "key_revoked", keyId: revoked.keyId });
  }

  const current = keys.find(
    ({ activeFrom, activeUntil }) =>
      activeFrom <= nowSeconds &&
      (activeUntil === undefined || activeUntil > nowSeconds),
  );
  const scheduled = keys.find(({ activeFrom }) => activeFrom > nowSeconds);

  // At most one key is made in one run, so key IDs, which name the second, never meet.
  let made: Pick<HeldKey, "activeFrom" | "activeUntil"> | undefined;
  if (current === undefined) {
    // On the first run, or after the key in use is revoked: no key is in use, so the new key is at
    // once, until the key scheduled after it, if there is one.
    made = {
      activeFrom: nowSeconds,
      ...(scheduled !== undefined && { activeUntil: scheduled.activeFrom }),
    };
  } else if (scheduled === undefined) {
    const activeFrom = Math.max(
      current.activeFrom + seconds(policy.periodMs),
      nowSeconds + seconds(policy.minimumLeadMs),
    );
    made = { activeFrom };
    keys = keys.map((key) =>
      key === current ? { ...key, activeUntil: activeFrom } : key,
    );
  }
  if (made !== undefined) {
    const keyId = keyIdFor(now);
    // Only a revocation in the second its key was made could meet this.
    if ([...keys, ...revokedKeys].some((key) => key.keyId === keyId)) {
      throw new Error(`A key was made as ${keyId} already; run again`);
    }
    keys.push({ keyId, ...(await ports.generate(keyId)), ...made });
    events.push({ event: "key_generated", keyId, activeFrom: made.activeFrom });
  }

  // A key that stopped long enough ago that nothing it was used for is still alive.
  keys = keys.filter(({ keyId, activeUntil }) => {
    const prune =
      activeUntil !== undefined &&
      nowSeconds - activeUntil >= seconds(policy.retiredKeptMs);
    if (prune) events.push({ event: "key_pruned", keyId });
    return !prune;
  });
  revokedKeys = revokedKeys.filter(
    ({ revokedAt }) => nowSeconds - revokedAt < seconds(policy.revokedKeptMs),
  );

  // Every key a reader is to use, on every run and before anything is written: a key made here
  // that fails is never kept, and one that fails later stops the run until it is revoked.
  for (const key of keys) {
    if (key.activeUntil !== undefined && key.activeUntil <= nowSeconds)
      continue;
    try {
      await ports.check(key);
    } catch (error) {
      throw new KeyCheckFailed(
        key.keyId,
        error instanceof Error ? error.name : typeof error,
        state.keys.some(({ keyId }) => keyId === key.keyId),
        error,
      );
    }
  }

  // Both tables change together, so every reader of either sees the same keys.
  const changes = changesBetween(state, { keys, revoked: revokedKeys });
  if (changes !== undefined) await ports.commit(state.version, changes);
  return { events };
}
