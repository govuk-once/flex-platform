// The tables a kind of key is kept in, as key rotation writes them and their readers read them.
// Field names suit any kind of key. Times are seconds since the epoch, as DynamoDB numbers.

/**
 * A key in a kind's private keys table: its ID, its private key as KMS encrypted it, when it is
 * first used, and, once the key after it is scheduled, when it stops. The table also holds keys
 * that have stopped, until rotation removes them, so a reader chooses by the times.
 */
export interface PrivateKeyItem {
  readonly keyId: { readonly S: string };
  readonly privateKey: { readonly B: Uint8Array };
  readonly activeFrom: { readonly N: string };
  readonly activeUntil?: { readonly N: string };
}
