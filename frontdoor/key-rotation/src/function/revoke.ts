// Removes one key at once, whatever it is doing. It reads the tables and changes them, and calls
// nothing else: a key that has to go is taken from every reader while KMS is disabled or
// throttled, while another key fails its check, and while no key can be made in its place. What
// replaces it is a run of rotation's, after this.

import type { RotationEvent, RotationPorts } from "./rotation.ts";
import { changesBetween, type HeldKey } from "./state.ts";

/** What a revocation does to AWS: the tables alone. */
export type RevocationPorts = Pick<RotationPorts, "read" | "commit">;

const withoutEnd = ({
  keyId,
  publicKey,
  privateKey,
  activeFrom,
}: HeldKey): HeldKey => ({ keyId, publicKey, privateKey, activeFrom });

/**
 * Takes the key out of both tables in one transaction, leaving its record in its public key's
 * place. A key revoked before is answered as already revoked, and one rotation neither holds nor
 * has revoked fails, either way changing nothing.
 */
export async function revoke(
  ports: RevocationPorts,
  now: Date,
  keyId: string,
): Promise<RotationEvent> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const state = await ports.read();

  const revoked = state.keys.find((key) => key.keyId === keyId);
  if (revoked === undefined) {
    if (!state.revoked.some((key) => key.keyId === keyId)) {
      throw new Error("The key to revoke is not one rotation holds");
    }
    // Run again, such as by a person who didn't hear that the first succeeded.
    return { event: "key_already_revoked", keyId };
  }

  // The key that was to hand over to a scheduled key no longer stops then, and rotation gives it
  // a new end when it schedules another. An end that has passed stays, so the key before a
  // revoked key in use is never used again.
  const keys = state.keys
    .filter((key) => key !== revoked)
    .map((key) =>
      key.activeUntil === revoked.activeFrom && key.activeUntil > nowSeconds
        ? withoutEnd(key)
        : key,
    );
  const changes = changesBetween(state, {
    keys,
    revoked: [...state.revoked, { keyId, revokedAt: nowSeconds }],
  });
  if (changes !== undefined) await ports.commit(state.version, changes);
  return { event: "key_revoked", keyId };
}
