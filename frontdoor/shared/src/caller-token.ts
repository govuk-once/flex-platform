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

/** How long a token is valid for, in seconds. */
export const CALLER_TOKEN_TTL_SECONDS = 60;

/**
 * A key the edge signs with, now or later: its ID, its private key as KMS encrypted it,
 * base64, and when it starts to sign, in seconds since the epoch. The edge signs with the latest
 * key that has started, so every edge switches to the next at the same moment, without a read.
 */
export interface SigningKey {
  readonly kid: string;
  readonly privateKey: string;
  readonly signsFrom: number;
}

// The UTC time the key was made, such as `20261106T120000Z`, so key IDs sort by age.
const KEY_ID = /^\d{8}T\d{6}Z$/;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

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

function isSigningKey(value: unknown): value is SigningKey {
  if (typeof value !== "object" || value === null) return false;
  const key = value as Record<string, unknown>;
  return (
    typeof key.kid === "string" &&
    isKeyId(key.kid) &&
    typeof key.privateKey === "string" &&
    BASE64.test(key.privateKey) &&
    typeof key.signsFrom === "number" &&
    Number.isInteger(key.signsFrom)
  );
}

/**
 * Reads the signing key parameter's value: the key signing now and the one scheduled next,
 * `{ "keys": [...] }`. Refuses anything else, whole.
 */
export function parseSigningKeys(text: string): SigningKey[] {
  const value: unknown = JSON.parse(text);
  const keys =
    typeof value === "object" && value !== null
      ? (value as { keys?: unknown }).keys
      : undefined;
  if (!Array.isArray(keys) || !keys.every(isSigningKey)) {
    throw new Error("The signing key parameter is not a set of signing keys");
  }
  return keys.map((key: SigningKey) => ({
    kid: key.kid,
    privateKey: key.privateKey,
    signsFrom: key.signsFrom,
  }));
}
