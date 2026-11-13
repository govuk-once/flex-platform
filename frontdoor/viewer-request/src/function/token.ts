// The shape of the caller's access token, checked before Lambda@Edge is paid to verify its
// signature. Nothing here is verification: a token that passes may still be forged, and
// Lambda@Edge refuses it. What fails here is malformed, expired, or from the wrong issuer or app
// client.

// Cognito access tokens are about 1 KB. Far larger is not one.
const MAX_TOKEN_LENGTH = 4096;

import { isCanonicalBase64url } from "@repo/cloudfront-js-utils/is-canonical-base64url";
import { jwtSegmentObject } from "@repo/cloudfront-js-utils/jwt-segment-object";
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
  const token = bearer.token;
  if (token.length > MAX_TOKEN_LENGTH) return invalid("length");

  const segments = token.split(".");
  if (segments.length !== 3) return invalid("segments");

  const header = jwtSegmentObject(segments[0]);
  if (!header) return invalid("header");
  // An allowlist, not a refusal of "none": Cognito signs access tokens with RS256 alone.
  if (header.alg !== "RS256") return invalid("algorithm");

  const payload = jwtSegmentObject(segments[1]);
  if (!payload) return invalid("payload");
  const signature = segments[2];
  if (signature === undefined || !isCanonicalBase64url(signature)) {
    return invalid("signature");
  }

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
