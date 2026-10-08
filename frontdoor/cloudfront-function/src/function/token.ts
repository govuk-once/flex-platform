// The shape of the caller's access token, checked before Lambda@Edge is paid to verify its
// signature. Nothing here is verification: a token that passes may still be forged, and
// Lambda@Edge refuses it. What fails here is malformed, expired, or from the wrong issuer or app
// client.

// Cognito access tokens are about 1 KB. Far larger is not one.
const MAX_TOKEN_LENGTH = 4096;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

import type { TrustedIssuer } from "./types.ts";

export type TokenEvent =
  "cff_token_missing" | "cff_token_invalid" | "cff_token_expired";

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
  if (!authorization) return missing("no-header");

  // `Bearer`, in any case (RFC 9110 11.1), then one or more spaces (RFC 6750 2.1), then the token.
  const space = authorization.indexOf(" ");
  const scheme = space === -1 ? authorization : authorization.slice(0, space);
  if (scheme.toLowerCase() !== "bearer") return invalid("scheme");
  const token =
    space === -1 ? "" : authorization.slice(space).replace(/^ +/, "");
  if (!token) return missing("no-token");
  if (token.indexOf(" ") !== -1) return invalid("parts");
  if (token.length > MAX_TOKEN_LENGTH) return invalid("length");

  const segments = token.split(".");
  if (segments.length !== 3) return invalid("segments");

  const header = decodeObject(segments[0]);
  if (!header) return invalid("header");
  // An allowlist, not a refusal of "none": Cognito signs access tokens with RS256 alone.
  if (header.alg !== "RS256") return invalid("algorithm");

  const payload = decodeObject(segments[1]);
  if (!payload) return invalid("payload");
  if (!segments[2] || !BASE64URL.test(segments[2])) return invalid("signature");

  const trusted = trustedIssuer(issuers, payload.iss);
  if (!trusted) return invalid("issuer");
  if (
    typeof payload.client_id !== "string" ||
    trusted.clientIds.indexOf(payload.client_id) === -1
  ) {
    return invalid("client");
  }
  if (payload.token_use !== "access") return invalid("token-use");
  // JSON can write an infinite number (1e400), which no expiry is.
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return invalid("expiry");
  }
  if (payload.exp <= nowSeconds) {
    return { event: "cff_token_expired", reason: "expired" };
  }

  return undefined;
}

function trustedIssuer(
  issuers: readonly TrustedIssuer[],
  iss: unknown,
): TrustedIssuer | undefined {
  // An index loop: the runtime has no for...of.
  for (let i = 0; i < issuers.length; i++) {
    if (issuers[i]!.issuer === iss) return issuers[i];
  }
  return undefined;
}

function missing(reason: string): TokenRejection {
  return { event: "cff_token_missing", reason };
}

function invalid(reason: string): TokenRejection {
  return { event: "cff_token_invalid", reason };
}

// A JWT segment is base64url without padding. The runtime's Buffer is given standard base64, so
// this works whichever encodings it supports.
function decodeObject(
  segment: string | undefined,
): Record<string, unknown> | undefined {
  if (!segment || !BASE64URL.test(segment)) return undefined;
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "===".slice(0, (4 - (base64.length % 4)) % 4);
  try {
    const value: unknown = JSON.parse(
      Buffer.from(padded, "base64").toString("utf8"),
    );
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Not JSON: refused below.
  }
  return undefined;
}
