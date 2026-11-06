/** What key rotation is built with, for one environment. */
export interface KeyRotationConfig {
  /** The alias of the key that wraps the signing keys. */
  readonly keyAlias: string;
  /** Where the edge reads the keys it signs with. */
  readonly signingKeyParameter: string;
  /** Where rotation keeps its state. */
  readonly stateParameter: string;
  /** The bucket every gateway reads the public keys from. */
  readonly publicKeysBucket: string;
  /**
   * The account that owns the bucket, this one. Every call names it, so a bucket of the same name
   * in another account is never read or written.
   */
  readonly publicKeysAccount: string;
  /** The public keys' object in that bucket. */
  readonly publicKeysObject: string;
  /** The bucket's region: the gateways' own. */
  readonly publicKeysRegion: string;
}
