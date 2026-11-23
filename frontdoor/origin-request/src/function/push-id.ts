// The push ID: the ID a caller's notifications are pushed to, which the edge signs into the caller
// token beside the pairwise ID it is made from.
//
// It is an HMAC of the pairwise ID under a secret only the edge reads, so nobody without the
// secret can turn one ID into the other. The edge reads the secret from Secrets Manager in the
// signing region, wherever it runs, once, and keeps it for as long as the copy runs: a new value
// would change every user's push ID, so the secret never changes.

import { createHmac } from "node:crypto";

import {
  GetSecretValueCommand,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { backingOff } from "@repo/utils/backing-off";
import { keptWhile } from "@repo/utils/kept-while";

/**
 * After a read that fails, or finds the secret without a value, how long the edge waits before
 * trying again. Until a read works, each request fails.
 */
export const PUSH_ID_SECRET_RETRY_MS = 30 * 1000;

// The read's whole budget. The function has 10 seconds, and reads the secret while it loads its
// signing key, not after.
const CALL_TIMEOUT_MS = 1_500;

/** The caller's push ID. */
export type DerivePushId = (pairwiseId: string) => Promise<string>;

export interface PushIdOptions {
  /** Secrets Manager in the signing region, where the secret is. */
  readonly secrets: Pick<SecretsManagerClient, "send">;
  readonly secretId: string;
}

/**
 * `base64url(HMAC-SHA256(pairwiseId))`, keyed with the whole secret as it is stored: every
 * character of it, never parsed and never trimmed. The same user has the same push ID wherever it
 * is derived from the same secret.
 */
export function pushIdFor(pairwiseId: string, secret: string): string {
  return createHmac("sha256", secret).update(pairwiseId).digest("base64url");
}

/**
 * Reads the secret, keeps it, and derives each caller's push ID with it. Until a read works, it
 * fails the request, so no token is signed without the claim.
 */
export function createPushIdDeriver(options: PushIdOptions): DerivePushId {
  // While the secret can't be read, or has no value, it isn't read again for every request.
  const secrets = backingOff(
    { fetch: (secretId: string) => read(options.secrets, secretId) },
    PUSH_ID_SECRET_RETRY_MS,
  );
  // Kept for as long as the copy runs: the value never changes.
  const secret = keptWhile(
    () => secrets.fetch(options.secretId),
    () => true,
  );

  return async (pairwiseId) => pushIdFor(pairwiseId, await secret());
}

async function read(
  secrets: PushIdOptions["secrets"],
  secretId: string,
): Promise<string> {
  const { SecretString } = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretId }),
    { abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
  );
  // An HMAC takes an empty key without complaint, and would give every user an ID anyone can
  // derive.
  if (SecretString === undefined || SecretString.trim() === "") {
    throw new Error("The push ID secret has no value");
  }
  return SecretString;
}
