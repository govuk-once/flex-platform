// One run of key rotation. It is safe to run at any time, as often as
// the schedule likes: each run does what is due and nothing else.
//
// A switch from one key to the next is a time, set when the next key is made, a period ahead, and
// kept as the time the current key stops. The edge holds both keys before then, and the gateways
// both public keys, so every edge switches at that moment without a read, and every gateway already
// accepts the new key. A gateway accepts a key only for a token issued while it signs, so the old
// key is worth nothing a token's life after the switch, whether or not it has been removed yet.

import { keyIdFor } from "@repo/frontdoor-shared";

import type { KeyState, StoredKey } from "./state.ts";
import { publicKeySet, signingKeys } from "./state.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** How long a key signs before the next replaces it. */
export const ROTATION_PERIOD_MS = 7 * 24 * HOUR;

/**
 * The least time between making a key and its starting to sign: longer than an edge goes between
 * reads of its keys, and than a gateway keeps the public keys, with every run until then to retry
 * a failed write. Normally a key is made a whole period ahead.
 */
export const MINIMUM_LEAD_MS = HOUR;

/**
 * How long a key stays published after it stops signing. Gateways refuse it for any token issued
 * since, so this only needs to outlast a token's life.
 */
export const RETIRED_KEPT_MS = 5 * MINUTE;

/**
 * How long a revoked key's ID is kept, so a revocation whose writes failed part way can be run
 * again. Every run writes what each reader should hold, so by then many runs have finished it.
 */
export const REVOKED_KEPT_MS = 24 * HOUR;

export interface GeneratedKey {
  readonly x: string;
  readonly privateKey: string;
}

/** What a run does to AWS, so the run itself is plain logic. */
export interface RotationPorts {
  readState(): Promise<KeyState>;
  writeState(state: KeyState): Promise<void>;
  /** Makes a key pair, its private key encrypted for the edge. */
  generate(kid: string): Promise<GeneratedKey>;
  /** Fails unless KMS can decrypt the private key, as the edge will ask it to. */
  check(key: Pick<StoredKey, "kid" | "privateKey">): Promise<void>;
  /** Writes the public key set where every gateway reads it. */
  publish(keySet: string): Promise<void>;
  /** Writes the keys the edge signs with. */
  distribute(signingKeys: string): Promise<void>;
}

export interface RotationRequest {
  /**
   * A key to remove at once, whatever it is doing. If it was signing, a new one signs straight away.
   * If it was scheduled, another is scheduled, at least the least lead ahead.
   */
  readonly revoke?: string;
}

export type RotationEventName =
  "key_generated" | "key_pruned" | "key_revoked" | "key_already_revoked";

export interface RotationEvent {
  readonly event: RotationEventName;
  readonly kid: string;
  /** For a key made, when it starts to sign, in seconds since the epoch. */
  readonly signsFrom?: number;
}

/** A key KMS wouldn't decrypt when a run checked it. */
export class KeyCheckFailed extends Error {
  constructor(
    readonly kid: string,
    /** AWS's name for the error, such as InvalidCiphertextException. */
    readonly reason: string,
    /** Whether rotation held the key before this run. It passed this check when it was made. */
    readonly stored: boolean,
    cause: unknown,
  ) {
    super(`The key ${kid} failed its check: ${reason}`, { cause });
  }
}

export interface RotationReport {
  readonly events: readonly RotationEvent[];
}

const seconds = (ms: number) => Math.floor(ms / 1000);

const withoutEnd = ({
  kid,
  x,
  privateKey,
  signsFrom,
}: StoredKey): StoredKey => ({
  kid,
  x,
  privateKey,
  signsFrom,
});

export async function rotate(
  ports: RotationPorts,
  now: Date,
  request: RotationRequest = {},
): Promise<RotationReport> {
  const events: RotationEvent[] = [];
  const nowSeconds = seconds(now.getTime());
  const state = await ports.readState();
  let keys = [...state.keys];
  let revokedKeys = [...state.revoked];

  const revoked = keys.find(({ kid }) => kid === request.revoke);
  if (request.revoke !== undefined && revoked === undefined) {
    if (!revokedKeys.some(({ kid }) => kid === request.revoke)) {
      throw new Error("The key to revoke is not one rotation holds");
    }
    // Run again after a write failed: the rest of the run writes what is still to be written.
    events.push({ event: "key_already_revoked", kid: request.revoke });
  }
  if (revoked !== undefined) {
    // The key that was to hand over to a scheduled key no longer stops then, and is given a new
    // end below. An end that has passed stays, so the key before a revoked signing key never
    // signs again.
    keys = keys
      .filter((key) => key !== revoked)
      .map((key) =>
        key.signsUntil === revoked.signsFrom && key.signsUntil > nowSeconds
          ? withoutEnd(key)
          : key,
      );
    revokedKeys.push({ kid: revoked.kid, revokedAt: nowSeconds });
    events.push({ event: "key_revoked", kid: revoked.kid });
  }

  const signing = keys.find(
    ({ signsFrom, signsUntil }) =>
      signsFrom <= nowSeconds &&
      (signsUntil === undefined || signsUntil > nowSeconds),
  );
  const scheduled = keys.find(({ signsFrom }) => signsFrom > nowSeconds);

  // At most one key is made in one run, so key IDs, which name the second, never meet.
  let made: Pick<StoredKey, "signsFrom" | "signsUntil"> | undefined;
  if (signing === undefined) {
    // On the first run, or after the signing key is revoked: nothing signs, so the new key does at
    // once, until the key scheduled after it, if there is one.
    made = {
      signsFrom: nowSeconds,
      ...(scheduled !== undefined && { signsUntil: scheduled.signsFrom }),
    };
  } else if (scheduled === undefined) {
    const signsFrom = Math.max(
      signing.signsFrom + seconds(ROTATION_PERIOD_MS),
      nowSeconds + seconds(MINIMUM_LEAD_MS),
    );
    made = { signsFrom };
    keys = keys.map((key) =>
      key === signing ? { ...key, signsUntil: signsFrom } : key,
    );
  }
  if (made !== undefined) {
    const kid = keyIdFor(now);
    // Only a revocation in the second its key was made could meet this.
    if ([...keys, ...revokedKeys].some((key) => key.kid === kid)) {
      throw new Error(`A key was made as ${kid} already; run again`);
    }
    keys.push({ kid, ...(await ports.generate(kid)), ...made });
    events.push({ event: "key_generated", kid, signsFrom: made.signsFrom });
  }

  // A key that stopped signing long enough ago that no token it signed is still alive.
  keys = keys.filter(({ kid, signsUntil }) => {
    const prune =
      signsUntil !== undefined &&
      nowSeconds - signsUntil >= seconds(RETIRED_KEPT_MS);
    if (prune) events.push({ event: "key_pruned", kid });
    return !prune;
  });
  revokedKeys = revokedKeys.filter(
    ({ revokedAt }) => nowSeconds - revokedAt < seconds(REVOKED_KEPT_MS),
  );

  // Every key the edge is to hold, on every run and before anything is written: a key made here
  // that fails is never kept, and one that fails later stops the run until it is revoked.
  for (const key of keys) {
    if (key.signsUntil !== undefined && key.signsUntil <= nowSeconds) continue;
    try {
      await ports.check(key);
    } catch (error) {
      throw new KeyCheckFailed(
        key.kid,
        error instanceof Error ? error.name : typeof error,
        state.keys.some(({ kid }) => kid === key.kid),
        error,
      );
    }
  }

  // Kept first, so a key made here is never lost. Published before the edge is given it, so no
  // edge signs with a key a gateway can't have read. Every run writes what each reader should
  // hold, so a write that failed is put right by the next run.
  const next = { keys, revoked: revokedKeys };
  await ports.writeState(next);
  await ports.publish(publicKeySet(next));
  await ports.distribute(signingKeys(next, nowSeconds));
  return { events };
}
