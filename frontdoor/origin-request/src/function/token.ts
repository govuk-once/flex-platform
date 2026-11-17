// Verifies the caller's Cognito access token. The CloudFront Function checked its shape. This is
// what proves it: the signature against the issuer's published keys, and every claim the platform
// relies on.

import { isCanonicalBase64url } from "@repo/cloudfront-js-utils/is-canonical-base64url";
import type { TrustedIssuer } from "@repo/frontdoor-shared";
import { backingOff } from "@repo/utils/backing-off";
import { keptFresh } from "@repo/utils/kept-fresh";
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
import { type Fetcher, SimpleFetcher } from "aws-jwt-verify/https";
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

/** Who a verified token is for: its `username`, which the platform calls the pairwise ID. */
export interface VerifiedCaller {
  readonly pairwiseId: string;
}

export type VerifyToken = (
  token: string,
) => Promise<TokenRejection | VerifiedCaller>;

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

// The library keeps an issuer's keys for as long as the function's instance lives, and fetches
// them again only for a key ID they didn't hold. So a key the issuer removed would go on
// verifying tokens. Keys this old are fetched again before they are used, and a request whose
// fetch fails then fails closed.
export const KEYS_MAX_AGE_MS = 10 * 60 * 1000;

// The library waits before fetching again only for a key ID the keys didn't hold, not after a
// fetch that failed. So while an issuer can't be reached, every request to an instance without
// its keys would fetch them again. For this long after a fetch that failed, or one that answered
// with something other than keys, they are not fetched again.
export const KEYS_BACKOFF_MS = 5_000;

// The library's parser of an issuer's keys, which it gives only as a cache's own.
const { jwksParser: parseKeys } = new SimpleJwksCache();

// One verifier per issuer, chosen by the token's own `iss`. Each fetches its issuer's keys on
// first use, again once they are too old, and for a key ID it hasn't seen. `fetcher` replaces the
// network in tests.
export function createTokenVerifier(
  issuers: readonly TrustedIssuer[],
  fetcher: Fetcher = new SimpleFetcher(),
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
      const verify =
        payload.iss === undefined ? undefined : verifiers.get(payload.iss);
      if (!verify) return { reason: "issuer" };
      const { username } = await verify(token);
      // The claim checks have already held it to a string that isn't empty.
      if (typeof username !== "string") return { reason: "username" };
      return { pairwiseId: username };
    } catch (error) {
      const reason = rejectionReason(error);
      if (reason === undefined) throw error;
      return { reason };
    }
  };
}

function issuerVerifier(
  trusted: TrustedIssuer,
  fetcher: Fetcher,
): (token: string) => Promise<JwtPayload> {
  // Where the library looks for an issuer's keys by default, named so they can be kept fresh.
  const keysUri = `${trusted.issuer}/.well-known/jwks.json`;
  // The cache parses the keys after its fetcher answers. They are parsed inside the back-off as
  // well, so an answer that isn't keys counts as a fetch that failed.
  const keys = new SimpleJwksCache({
    fetcher: backingOff(fetcher, KEYS_BACKOFF_MS, parseKeys),
  });
  const keysAreFresh = keptFresh((uri) => keys.getJwks(uri), KEYS_MAX_AGE_MS);
  const verifier = JwtVerifier.create(
    {
      // Matched exactly. Cognito's verifier would also accept the pool's global issuer format,
      // which is more than the config names.
      issuer: trusted.issuer,
      // Access tokens carry the app client as `client_id`, not `aud`.
      audience: null,
      jwksUri: keysUri,
      customJwtCheck: ({ header, payload }) => {
        checkClaims(header.alg, payload, trusted.clientIds);
      },
    },
    { jwksCache: keys },
  );
  return async (token) => {
    await keysAreFresh(keysUri);
    return verifier.verify(token);
  };
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
  // The library accepts a token in the instant it expires. The CloudFront Function refuses it.
  if (payload.exp <= Date.now() / 1000) throw new ClaimRejected("expired");
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
