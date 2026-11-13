import { parseSigningKeys, type SigningKey } from "@repo/frontdoor-shared";

import type { GeneratedKey, RotationPorts } from "../src/function/rotation.ts";
import { EMPTY_STATE, type KeyState } from "../src/function/state.ts";

interface PublishedKey {
  readonly kid: string;
  readonly signsFrom: number;
  readonly signsUntil?: number;
}

/** Rotation's ports, held in memory, recording what each run did and in what order. */
export class MemoryPorts implements RotationPorts {
  state: KeyState = EMPTY_STATE;
  published: string | null = null;
  distributed: SigningKey[] = [];
  readonly calls: string[] = [];
  failDistribution = false;
  failPublish = false;
  /** The ID of a key KMS can't decrypt. */
  undecryptable: string | undefined;

  readState(): Promise<KeyState> {
    return Promise.resolve(this.state);
  }

  writeState(state: KeyState): Promise<void> {
    this.calls.push("writeState");
    this.state = state;
    return Promise.resolve();
  }

  generate(kid: string): Promise<GeneratedKey> {
    this.calls.push(`generate ${kid}`);
    return Promise.resolve({
      x: Buffer.from(`public ${kid}`).toString("base64url"),
      privateKey: Buffer.from(`private ${kid}`).toString("base64"),
    });
  }

  check({ kid }: { readonly kid: string }): Promise<void> {
    this.calls.push(`check ${kid}`);
    if (kid === this.undecryptable) {
      const error = new Error("KMS refused the ciphertext");
      error.name = "InvalidCiphertextException";
      return Promise.reject(error);
    }
    return Promise.resolve();
  }

  publish(keySet: string): Promise<void> {
    this.calls.push("publish");
    if (this.failPublish) {
      return Promise.reject(new Error("S3 refused the keys"));
    }
    this.published = keySet;
    return Promise.resolve();
  }

  distribute(signingKeys: string): Promise<void> {
    this.calls.push("distribute");
    if (this.failDistribution) {
      return Promise.reject(new Error("SSM refused"));
    }
    this.distributed = parseSigningKeys(signingKeys);
    return Promise.resolve();
  }

  publishedKeys(): PublishedKey[] {
    const set = JSON.parse(this.published ?? '{"keys":[]}') as {
      keys: PublishedKey[];
    };
    return set.keys.map(({ kid, signsFrom, signsUntil }) => ({
      kid,
      signsFrom,
      ...(signsUntil !== undefined && { signsUntil }),
    }));
  }

  publishedKids(): string[] {
    return this.publishedKeys().map(({ kid }) => kid);
  }

  /** The key the edge signs with at a moment: the latest it holds that has started. */
  signingKid(at: Date): string | undefined {
    const seconds = Math.floor(at.getTime() / 1000);
    return this.distributed
      .filter(({ signsFrom }) => signsFrom <= seconds)
      .sort((a, b) => b.signsFrom - a.signsFrom)[0]?.kid;
  }
}
