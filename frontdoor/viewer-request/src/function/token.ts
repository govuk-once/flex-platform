// The shape of the caller's access token, checked before Lambda@Edge is paid to verify its
// signature. Nothing here is verification: a token that passes may still be forged, and
// Lambda@Edge refuses it. What fails here is malformed, expired, or from the wrong issuer or app
// client.

// Cognito access tokens are about 1 KB. Far larger is not one.
const MAX_TOKEN_LENGTH = 4096;

import { rs256JwtPayload } from "@repo/cloudfront-js-utils/rs256-jwt-payload";
import type { TrustedIssuer } from "@repo/frontdoor-shared";
import { bearerToken } from "@repo/frontdoor-shared";

export type TokenEvent =
  | "viewer_request_token_missing"
  | "viewer_request_token_invalid"
  | "viewer_request_token_expired";

// The reason is one of the fixed codes below, never text from the token.
export interface TokenRejection {
  readonly event: TokenEvent;
  readonly reason: string;
}

export function checkToken(
  authorization: string | undefined,
  issuers: readonly TrustedIssuer[],
  nowSeconds: number,
): TokenRejection | undefined {
  const bearer = bearerToken(authorization);
  if (!("token" in bearer)) {
    return bearer.missing ? missing(bearer.reason) : invalid(bearer.reason);
  }
  // Cognito signs access tokens with RS256 alone.
  const payload = rs256JwtPayload(bearer.token, MAX_TOKEN_LENGTH);
  if (typeof payload === "string") return invalid(payload);

  const trusted = trustedIssuer(issuers, payload.iss);
  if (!trusted) return invalid("issuer");
  if (
    typeof payload.client_id !== "string" ||
    !trusted.clientIds.includes(payload.client_id)
  ) {
    return invalid("client");
  }
  if (payload.token_use !== "access") return invalid("token-use");
  // JSON can write an infinite number (1e400), which no expiry is.
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return invalid("expiry");
  }
  if (payload.exp <= nowSeconds) {
    return { event: "viewer_request_token_expired", reason: "expired" };
  }

  return undefined;
}

function trustedIssuer(
  issuers: readonly TrustedIssuer[],
  iss: unknown,
): TrustedIssuer | undefined {
  return issuers.find((trusted) => trusted.issuer === iss);
}

function missing(reason: string): TokenRejection {
  return { event: "viewer_request_token_missing", reason };
}

function invalid(reason: string): TokenRejection {
  return { event: "viewer_request_token_invalid", reason };
}
