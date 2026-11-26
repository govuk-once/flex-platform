import type { KeyKind } from "./policy.ts";

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
}
