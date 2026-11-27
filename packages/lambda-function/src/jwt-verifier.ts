// Verifies a JSON Web Token an issuer signed with RS256: the signature against the issuer's
// published keys, the standard claims, and the claims the caller relies on.

import { isCanonicalBase64url } from "@repo/cloudfront-js-utils/is-canonical-base64url";
import { backingOff } from "@repo/utils/backing-off";
import { keptFresh } from "@repo/utils/kept-fresh";
import {
  JwtExpiredError,
  JwtInvalidAudienceError,
  JwtInvalidIssuerError,
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

/**
 * Why a token was refused, as a fixed code. Never text from the token or from the library's
 * errors, which can hold a claim's value.
 */
export type JwtRejectionReason =
  | "malformed"
  | "issuer"
  | "audience"
  | "key"
  | "algorithm"
  | "signature"
  | "expired"
  | "not-yet-valid"
  | "no-expiry";

/** An issuer whose tokens are accepted, and what its tokens must hold. */
export interface JwtIssuer<Reason extends string> {
  /** Matched exactly. */
  readonly issuer: string;
  /** The `aud` a token must hold, or `null` for an issuer whose tokens hold none to check. */
  readonly audience: string | null;
  /** Where the issuer publishes its keys. */
  readonly keysUri: string;
  /**
   * Runs once the signature and the standard claims are verified, and refuses a token with
   * `reject`, for a reason of the caller's own.
   */
  readonly checkClaims: (
    payload: JwtPayload,
    reject: (reason: Reason) => never,
  ) => void;
}

export type VerifyJwt<Reason extends string> = (
  token: string,
) => Promise<
  | { readonly payload: JwtPayload }
  | { readonly reason: JwtRejectionReason | Reason }
>;

/**
 * The library keeps an issuer's keys for as long as the function's instance lives, and fetches
 * them again only for a key ID they didn't hold. So a key the issuer removed would go on
 * verifying tokens. Keys this old are fetched again before they are used, and a request whose
 * fetch fails then fails closed.
 */
export const KEYS_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The library waits before fetching again only for a key ID the keys didn't hold, not after a
 * fetch that failed. So while an issuer can't be reached, every request to an instance without
 * its keys would fetch them again. For this long after a fetch that failed, or one that answered
 * with something other than keys, they are not fetched again.
 */
export const KEYS_BACKOFF_MS = 5_000;

// Thrown by the claim checks, so a refusal keeps its own code.
class ClaimRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

// Library errors that mean the token is at fault. Anything else, such as keys that can't be
// fetched or parsed, is not the caller's doing and is thrown, so the request fails closed.
const REJECTIONS: readonly (readonly [
  new (...args: never[]) => Error,
  JwtRejectionReason,
])[] = [
  [JwtParseError, "malformed"],
  [JwtInvalidIssuerError, "issuer"],
  [JwtInvalidAudienceError, "audience"],
  [JwtWithoutValidKidError, "key"],
  [KidNotFoundInJwksError, "key"],
  // An unknown key ID while the issuer's keys can't be fetched again yet.
  [WaitPeriodNotYetEndedJwkError, "key"],
  [JwtInvalidSignatureAlgorithmError, "algorithm"],
  [JwtInvalidSignatureError, "signature"],
  [JwtExpiredError, "expired"],
  [JwtNotBeforeError, "not-yet-valid"],
];

// The library's parser of an issuer's keys, which it gives only as a cache's own.
const { jwksParser: parseKeys } = new SimpleJwksCache();

/**
 * One verifier per issuer, chosen by the token's own `iss`. Each fetches its issuer's keys on
 * first use, again once they are too old, and for a key ID it hasn't seen. A token from an issuer
 * not listed never has keys fetched. `fetcher` replaces the network in tests.
 */
export function createJwtVerifier<Reason extends string>(
  issuers: readonly JwtIssuer<Reason>[],
  fetcher: Fetcher = new SimpleFetcher(),
): VerifyJwt<Reason> {
  // A Map, because `iss` comes from the caller and an object lookup finds inherited members.
  const verifiers = new Map(
    issuers.map((trusted) => [
      trusted.issuer,
      issuerVerifier(trusted, fetcher),
    ]),
  );

  return async (token) => {
    // The library decodes leniently. Only the canonical encoding is verified, so a token has one
    // form, and anything before this that reads or counts tokens sees the one verified.
    const segments = token.split(".");
    if (segments.length !== 3 || !segments.every(isCanonicalBase64url)) {
      return { reason: "malformed" };
    }
    try {
      const { iss } = decomposeUnverifiedJwt(token).payload;
      const verify = iss === undefined ? undefined : verifiers.get(iss);
      if (!verify) return { reason: "issuer" };
      return { payload: await verify(token) };
    } catch (error) {
      const reason = rejectionReason(error);
      if (reason === undefined) throw error;
      // A claim check's reason is one of the caller's own.
      return { reason: reason as JwtRejectionReason | Reason };
    }
  };
}

function issuerVerifier<Reason extends string>(
  trusted: JwtIssuer<Reason>,
  fetcher: Fetcher,
): (token: string) => Promise<JwtPayload> {
  // The cache parses the keys after its fetcher answers. They are parsed inside the back-off as
  // well, so an answer that isn't keys counts as a fetch that failed.
  const keys = new SimpleJwksCache({
    fetcher: backingOff(fetcher, KEYS_BACKOFF_MS, parseKeys),
  });
  const keysAreFresh = keptFresh((uri) => keys.getJwks(uri), KEYS_MAX_AGE_MS);
  const reject = (reason: Reason): never => {
    throw new ClaimRejected(reason);
  };
  const verifier = JwtVerifier.create(
    {
      issuer: trusted.issuer,
      audience: trusted.audience,
      jwksUri: trusted.keysUri,
      customJwtCheck: ({ header, payload }) => {
        checkStandardClaims(header.alg, payload);
        trusted.checkClaims(payload, reject);
      },
    },
    { jwksCache: keys },
  );
  return async (token) => {
    await keysAreFresh(trusted.keysUri);
    return verifier.verify(token);
  };
}

// Runs after the signature is verified.
function checkStandardClaims(
  alg: string | undefined,
  payload: JwtPayload,
): void {
  // The library accepts any algorithm the key allows. The issuers sign with RS256 alone.
  if (alg !== "RS256") throw new ClaimRejected("algorithm");
  // The library checks `exp` only when there is one.
  if (payload.exp === undefined) throw new ClaimRejected("no-expiry");
  // The library accepts a token in the instant it expires. `exp` is the instant a token must no
  // longer be accepted from.
  if (payload.exp <= Date.now() / 1000) throw new ClaimRejected("expired");
}

function rejectionReason(error: unknown): string | undefined {
  if (error instanceof ClaimRejected) return error.reason;
  return REJECTIONS.find(([type]) => error instanceof type)?.[1];
}
