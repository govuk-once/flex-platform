// Verifies the caller's Cognito access token. The CloudFront Function checked its shape. This is
// what proves it: the signature against the issuer's published keys, and every claim the platform
// relies on.

import type { TrustedIssuer } from "@repo/frontdoor-shared";
import {
  createJwtVerifier,
  type JwtRejectionReason,
} from "@repo/lambda-function";
import type { Fetcher } from "aws-jwt-verify/https";

export { KEYS_BACKOFF_MS, KEYS_MAX_AGE_MS } from "@repo/lambda-function";

// Why a token was refused, as a fixed code. Never text from the token or from the library's
// errors, which can hold a claim's value.
export type TokenRejectionReason =
  JwtRejectionReason | "token-use" | "client" | "username";

export interface TokenRejection {
  readonly reason: TokenRejectionReason;
}

/** Who a verified token is for: its `username`, which the platform calls the pairwise ID. */
export interface VerifiedCaller {
  readonly pairwiseId: string;
}

export type VerifyToken = (
  token: string,
) => Promise<TokenRejection | VerifiedCaller>;

// `fetcher` replaces the network in tests.
export function createTokenVerifier(
  issuers: readonly TrustedIssuer[],
  fetcher?: Fetcher,
): VerifyToken {
  const verify = createJwtVerifier<"token-use" | "client" | "username">(
    issuers.map(({ issuer, clientIds }) => ({
      // Matched exactly. Cognito's verifier would also accept the pool's global issuer format,
      // which is more than the config names.
      issuer,
      // Access tokens carry the app client as `client_id`, not `aud`.
      audience: null,
      // Where the library looks for an issuer's keys by default, named so they can be kept fresh.
      keysUri: `${issuer}/.well-known/jwks.json`,
      checkClaims: (payload, reject) => {
        if (payload.token_use !== "access") reject("token-use");
        if (
          typeof payload.client_id !== "string" ||
          !clientIds.includes(payload.client_id)
        ) {
          reject("client");
        }
        // The pairwise ID that later identifies the user to a domain.
        if (typeof payload.username !== "string" || payload.username === "") {
          reject("username");
        }
      },
    })),
    fetcher,
  );

  return async (token) => {
    const verified = await verify(token);
    if ("reason" in verified) return verified;
    const { username } = verified.payload;
    // The claim checks have already held it to a string that isn't empty.
    if (typeof username !== "string") return { reason: "username" };
    return { pairwiseId: username };
  };
}
