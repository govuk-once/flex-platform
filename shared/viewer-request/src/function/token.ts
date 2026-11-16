// The shape of a pipeline's token, checked before the origin is paid to verify its signature.
// Nothing here is verification: a token that passes may still be forged, and the origin refuses
// it. What fails here is malformed, expired, from another issuer or for another audience.
import { rs256JwtPayload } from "@repo/cloudfront-js-utils/rs256-jwt-payload";

import type { ViewerRequestConfig } from "./types.ts";

/**
 * The header a pipeline sends its token in, as the token alone, with no scheme. Not
 * `Authorization`, which CloudFront replaces with its own signature for the origin.
 */
export const CI_TOKEN_HEADER = "x-flex-ci-token";

// A job's token is a few kilobytes at most. Far larger is not one.
const MAX_TOKEN_LENGTH = 8192;

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
  token: string | undefined,
  config: ViewerRequestConfig,
  nowSeconds: number,
): TokenRejection | undefined {
  if (!token) {
    return { event: "viewer_request_token_missing", reason: "no-header" };
  }

  // The issuer signs a job's token with RS256 alone.
  const payload = rs256JwtPayload(token, MAX_TOKEN_LENGTH);
  if (typeof payload === "string") return invalid(payload);

  if (payload.iss !== config.issuer) return invalid("issuer");
  if (!isFor(payload.aud, config.audience)) return invalid("audience");
  // JSON can write an infinite number (1e400), which no expiry is.
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return invalid("expiry");
  }
  if (payload.exp <= nowSeconds) {
    return { event: "viewer_request_token_expired", reason: "expired" };
  }

  return undefined;
}

// A JWT names its audience as one string, or as a list of them.
function isFor(aud: unknown, audience: string): boolean {
  return Array.isArray(aud) ? aud.includes(audience) : aud === audience;
}

function invalid(reason: string): TokenRejection {
  return { event: "viewer_request_token_invalid", reason };
}
