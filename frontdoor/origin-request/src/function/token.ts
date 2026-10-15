// Verifies the caller's Cognito access token. The CloudFront Function checked its shape. This is
// what proves it: the signature against the issuer's published keys, and every claim the platform
// relies on.

import type { TrustedIssuer } from "@repo/frontdoor-shared";
import { isCanonicalBase64url } from "@repo/frontdoor-shared";
import {
  JwtExpiredError,
  JwtInvalidSignatureAlgorithmError,
  JwtInvalidSignatureError,
  JwtNotBeforeError,
  JwtParseError,
  JwtWithoutValidKidError,
  KidNotFoundInJwksError,
  WaitPeriodNotYetEndedJwkError,
} from "aws-jwt-verify/error";
import type { Fetcher } from "aws-jwt-verify/https";
import { SimpleJwksCache } from "aws-jwt-verify/jwk";
import { decomposeUnverifiedJwt } from "aws-jwt-verify/jwt";
import type { JwtPayload } from "aws-jwt-verify/jwt-model";
import { JwtVerifier } from "aws-jwt-verify/jwt-verifier";

// Why a token was refused, as a fixed code. Never text from the token or from the library's
// errors, which can hold a claim's value.
export type TokenRejectionReason =
  | "malformed"
  | "issuer"
  | "key"
  | "algorithm"
  | "signature"
  | "expired"
  | "not-yet-valid"
  | "no-expiry"
  | "token-use"
  | "client"
  | "username";

export interface TokenRejection {
  readonly reason: TokenRejectionReason;
}

export type VerifyToken = (
  token: string,
) => Promise<TokenRejection | undefined>;

// Thrown by the claim checks below, so a refusal keeps its own code.
class ClaimRejected extends Error {
  constructor(readonly reason: TokenRejectionReason) {
    super(reason);
  }
}

// Library errors that mean the token is at fault. Anything else, such as a JWKS that can't be
// fetched or parsed, is not the caller's doing and is thrown, so the request fails closed.
const REJECTIONS: readonly (readonly [
  new (...args: never[]) => Error,
  TokenRejectionReason,
])[] = [
  [JwtParseError, "malformed"],
  [JwtWithoutValidKidError, "key"],
  [KidNotFoundInJwksError, "key"],
  // An unknown key ID while the issuer's keys can't be fetched again yet.
  [WaitPeriodNotYetEndedJwkError, "key"],
  [JwtInvalidSignatureAlgorithmError, "algorithm"],
  [JwtInvalidSignatureError, "signature"],
  [JwtExpiredError, "expired"],
  [JwtNotBeforeError, "not-yet-valid"],
];

// One verifier per issuer, chosen by the token's own `iss`. Each fetches its issuer's keys once,
// on first use, and again only for a key ID it hasn't seen. `fetcher` replaces the network in
// tests.
export function createTokenVerifier(
  issuers: readonly TrustedIssuer[],
  fetcher?: Fetcher,
): VerifyToken {
  // A Map, because `iss` comes from the caller and an object lookup finds inherited members.
  const verifiers = new Map(
    issuers.map((trusted) => [
      trusted.issuer,
      issuerVerifier(trusted, fetcher),
    ]),
  );

  return async (token) => {
    // The library decodes leniently. WAF counts each encoding of a token separately, so only the
    // one the CloudFront Function accepts is verified.
    const segments = token.split(".");
    if (segments.length !== 3 || !segments.every(isCanonicalBase64url)) {
      return { reason: "malformed" };
    }
    try {
      const { payload } = decomposeUnverifiedJwt(token);
      const verifier =
        payload.iss === undefined ? undefined : verifiers.get(payload.iss);
      if (!verifier) return { reason: "issuer" };
      await verifier.verify(token);
      return undefined;
    } catch (error) {
      const reason = rejectionReason(error);
      if (reason === undefined) throw error;
      return { reason };
    }
  };
}

function issuerVerifier(trusted: TrustedIssuer, fetcher: Fetcher | undefined) {
  return JwtVerifier.create(
    {
      // Matched exactly. Cognito's verifier would also accept the pool's global issuer format,
      // which is more than the config names.
      issuer: trusted.issuer,
      // Access tokens carry the app client as `client_id`, not `aud`.
      audience: null,
      customJwtCheck: ({ header, payload }) => {
        checkClaims(header.alg, payload, trusted.clientIds);
      },
    },
    {
      jwksCache: new SimpleJwksCache(fetcher === undefined ? {} : { fetcher }),
    },
  );
}

// Runs after the signature is verified.
function checkClaims(
  alg: string | undefined,
  payload: JwtPayload,
  clientIds: readonly string[],
): void {
  // The library accepts any algorithm the key allows. Cognito signs access tokens with RS256 alone.
  if (alg !== "RS256") throw new ClaimRejected("algorithm");
  // The library checks `exp` only when there is one.
  if (payload.exp === undefined) throw new ClaimRejected("no-expiry");
  if (payload.token_use !== "access") throw new ClaimRejected("token-use");
  if (
    typeof payload.client_id !== "string" ||
    !clientIds.includes(payload.client_id)
  ) {
    throw new ClaimRejected("client");
  }
  // The pairwise ID that later identifies the user to a domain.
  if (typeof payload.username !== "string" || payload.username === "") {
    throw new ClaimRejected("username");
  }
}

function rejectionReason(error: unknown): TokenRejectionReason | undefined {
  if (error instanceof ClaimRejected) return error.reason;
  return REJECTIONS.find(([type]) => error instanceof type)?.[1];
}
