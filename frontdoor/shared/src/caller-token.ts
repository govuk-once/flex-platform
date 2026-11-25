// The caller token's keys, as key rotation writes them and Lambda@Edge reads them.
//
// The keys are made and kept in one region, nearest to most requests, where every copy of the edge
// reads them.

/** Where the signing keys are made and kept, and key rotation runs. */
export const SIGNING_KEY_REGION = "eu-west-2";

/**
 * The encryption context's `purpose`, which every encrypted signing key is bound to, beside its
 * `kid`. The edge's role may decrypt only with it.
 */
export const SIGNING_KEY_PURPOSE = "flex-caller-token";

/**
 * Who the token is for: the environment's gateways, which each check it. Each environment's keys
 * are its own as well, so a token from one is refused by another's gateways twice over.
 */
export function callerTokenAudience(environment: string): string {
  return `flex:${environment}:gateways`;
}

/** How long a token is valid for, in seconds. */
export const CALLER_TOKEN_TTL_SECONDS = 60;

// The UTC time the key was made, such as `20261106T120000Z`, so key IDs sort by age.
const KEY_ID = /^\d{8}T\d{6}Z$/;

export function isKeyId(kid: string): boolean {
  return KEY_ID.test(kid);
}

/** The key ID for a key made at `at`. */
export function keyIdFor(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}
