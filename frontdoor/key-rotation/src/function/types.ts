import type { KeyKind } from "./policy.ts";

/** Where a kind publishes its public keys: one object in a bucket. */
export interface PublicationConfig {
  readonly bucket: string;
  /**
   * The account that owns the bucket, this one. Every call names it, so a bucket of the same name
   * in another account is never read or written.
   */
  readonly account: string;
  /** The object in that bucket. */
  readonly object: string;
  /** The bucket's region. */
  readonly region: string;
}

/** What key rotation is built with, for one kind of key in one environment. */
export interface KeyRotationConfig {
  /** The kind, which chooses its policy. */
  readonly kind: KeyKind;
  /** The alias of the KMS key that wraps the private keys. */
  readonly keyAlias: string;
  /** The table of private keys, which the kind's readers read. */
  readonly privateKeysTable: string;
  /** The table of public keys, which also holds rotation's version and revocations. */
  readonly publicKeysTable: string;
  /** Where the kind's public keys are published, for a kind whose policy publishes them. */
  readonly publication: PublicationConfig | null;
}
