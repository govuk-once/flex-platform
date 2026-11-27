import { generateKeyPairSync } from "node:crypto";

import type { GeneratedKey, RotationPorts } from "../src/function/rotation.ts";
import {
  EMPTY_STATE,
  type HeldKey,
  type KeyChanges,
  type KeyState,
} from "../src/function/state.ts";

interface PublicKey {
  readonly keyId: string;
  readonly activeFrom: number;
  readonly activeUntil?: number;
}

/** An Ed25519 public key as KMS returns one: DER, as a SubjectPublicKeyInfo. */
export function publicKeyDer(): Uint8Array {
  return new Uint8Array(
    generateKeyPairSync("ed25519").publicKey.export({
      format: "der",
      type: "spki",
    }),
  );
}

/** Applies a commit's changes to a state, as the tables would. */
export function applied(state: KeyState, changes: KeyChanges): KeyState {
  const replaced = new Set([
    ...changes.put.map(({ keyId }) => keyId),
    ...changes.remove,
    ...changes.revoke.map(({ keyId }) => keyId),
  ]);
  const forgotten = new Set(changes.forget);
  return {
    version: state.version + 1,
    keys: [
      ...state.keys.filter(({ keyId }) => !replaced.has(keyId)),
      ...changes.put,
    ],
    revoked: [
      ...state.revoked.filter(({ keyId }) => !forgotten.has(keyId)),
      ...changes.revoke,
    ],
  };
}

/** Rotation's ports, held in memory, recording what each run did and in what order. */
export class MemoryPorts implements RotationPorts {
  state: KeyState = EMPTY_STATE;
  readonly calls: string[] = [];
  failCommit = false;
  /** The ID of a key KMS can't decrypt. */
  undecryptable: string | undefined;

  read(): Promise<KeyState> {
    return Promise.resolve(this.state);
  }

  commit(version: number, changes: KeyChanges): Promise<void> {
    this.calls.push("commit");
    if (this.failCommit) {
      return Promise.reject(new Error("DynamoDB refused the transaction"));
    }
    if (version !== this.state.version) {
      return Promise.reject(new Error("stale"));
    }
    this.state = applied(this.state, changes);
    return Promise.resolve();
  }

  generate(keyId: string): Promise<GeneratedKey> {
    this.calls.push(`generate ${keyId}`);
    return Promise.resolve({
      publicKey: publicKeyDer(),
      privateKey: new Uint8Array(Buffer.from(`private ${keyId}`)),
    });
  }

  check({ keyId }: Pick<HeldKey, "keyId">): Promise<void> {
    this.calls.push(`check ${keyId}`);
    if (keyId === this.undecryptable) {
      const error = new Error("KMS refused the ciphertext");
      error.name = "InvalidCiphertextException";
      return Promise.reject(error);
    }
    return Promise.resolve();
  }

  /** The keys a gateway reads from the public keys table, with their times, by key ID. */
  publicKeys(): PublicKey[] {
    return [...this.state.keys]
      .sort((a, b) => (a.keyId < b.keyId ? -1 : 1))
      .map(({ keyId, activeFrom, activeUntil }) => ({
        keyId,
        activeFrom,
        ...(activeUntil !== undefined && { activeUntil }),
      }));
  }

  publicKids(): string[] {
    return this.publicKeys().map(({ keyId }) => keyId);
  }

  /** The keys the edge would hold at a moment: every key in the table that hasn't stopped. */
  edgeKids(at: Date): string[] {
    const seconds = Math.floor(at.getTime() / 1000);
    return this.state.keys
      .filter(
        ({ activeUntil }) => activeUntil === undefined || activeUntil > seconds,
      )
      .map(({ keyId }) => keyId)
      .sort();
  }

  /** The key the edge signs with at a moment: the latest that has started and not stopped. */
  signingKid(at: Date): string | undefined {
    const seconds = Math.floor(at.getTime() / 1000);
    return this.state.keys
      .filter(
        ({ activeFrom, activeUntil }) =>
          activeFrom <= seconds &&
          (activeUntil === undefined || activeUntil > seconds),
      )
      .sort((a, b) => b.activeFrom - a.activeFrom)[0]?.keyId;
  }
}
