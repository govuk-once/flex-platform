// Verifies a pipeline's token. The CloudFront Function checked its shape. This is what proves it:
// the signature against the issuer's published keys, and every claim the platform relies on.
//
// Anyone with a GitHub repository can have GitHub sign a token for this audience. So a verified
// token says only which repository's pipeline is calling, and what it may do is decided after, by
// the repository's and its owner's IDs. Never by `sub`, whose format a repository's admin sets.

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

import type { CiConfig } from "./types.ts";

// Why a token was refused, as a fixed code. Never text from the token or from the library's
// errors, which can hold a claim's value.
export type TokenRejectionReason =
  | "malformed"
  | "issuer"
  | "audience"
  | "key"
  | "algorithm"
  | "signature"
  | "expired"
  | "not-yet-valid"
  | "no-expiry"
  | "repository";

export interface TokenRejection {
  readonly reason: TokenRejectionReason;
}

/** The pipeline a verified token is from. Every ID is digits, as GitHub issues them. */
export interface Pipeline {
  readonly repositoryId: string;
  readonly ownerId: string;
  /** The GitHub environment the job runs in. A job that names none has no such claim. */
  readonly environment: string | undefined;
  /** The workflow run, for the log. */
  readonly runId: string | undefined;
  /** The commit the job runs for, for the log. */
  readonly commit: string | undefined;
}

export type VerifyToken = (token: string) => Promise<TokenRejection | Pipeline>;

// A job's token is a few kilobytes at most, and the CloudFront Function lets no longer one through.
const MAX_TOKEN_LENGTH = 8192;

/**
 * The library keeps an issuer's keys for as long as the function's instance lives, and fetches
 * them again only for a key ID they didn't hold. So a key the issuer removed would go on
 * verifying tokens. Keys this old are fetched again before they are used, and a request whose
 * fetch fails then fails closed.
 */
export const KEYS_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The library doesn't wait after a fetch that failed, so while the issuer can't be reached every
 * request would fetch again. For this long after a fetch that failed, or one that answered with
 * something other than keys, they are not fetched again.
 */
export const KEYS_BACKOFF_MS = 5_000;

// The library's parser of an issuer's keys, which it gives only as a cache's own.
const { jwksParser: parseKeys } = new SimpleJwksCache();

const ID = /^\d{1,20}$/;

// A commit's SHA-1 or SHA-256, in hex.
const COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

// Thrown by the claim checks below, so a refusal keeps its own code.
class ClaimRejected extends Error {
  constructor(readonly reason: TokenRejectionReason) {
    super(reason);
  }
}

// Library errors that mean the token is at fault. Anything else, such as keys that can't be
// fetched or parsed, is not the caller's doing and is thrown, so the request fails closed.
const REJECTIONS: readonly (readonly [
  new (...args: never[]) => Error,
  TokenRejectionReason,
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

// `fetcher` replaces the network in tests.
export function createTokenVerifier(
  config: Pick<CiConfig, "issuer" | "keysUri" | "audience">,
  fetcher: Fetcher = new SimpleFetcher(),
): VerifyToken {
  // The cache parses the keys after its fetcher answers. They are parsed inside the back-off as
  // well, so an answer that isn't keys counts as a fetch that failed.
  const keys = new SimpleJwksCache({
    fetcher: backingOff(fetcher, KEYS_BACKOFF_MS, parseKeys),
  });
  const keysAreFresh = keptFresh(
    (keysUri) => keys.getJwks(keysUri),
    KEYS_MAX_AGE_MS,
  );
  const verifier = JwtVerifier.create(
    {
      issuer: config.issuer,
      audience: config.audience,
      // Named, since the library's default for an issuer is not where GitHub publishes its keys.
      jwksUri: config.keysUri,
      customJwtCheck: ({ header, payload }) => {
        checkClaims(header.alg, payload);
      },
    },
    { jwksCache: keys },
  );

  return async (token) => {
    // The library decodes leniently. The web ACL counts each encoding of a token separately, so
    // only the one the CloudFront Function accepts is verified.
    const segments = token.split(".");
    if (
      token.length > MAX_TOKEN_LENGTH ||
      segments.length !== 3 ||
      !segments.every(isCanonicalBase64url)
    ) {
      return { reason: "malformed" };
    }
    try {
      // Before the keys are needed, so a token from anyone else never has them fetched.
      if (decomposeUnverifiedJwt(token).payload.iss !== config.issuer) {
        return { reason: "issuer" };
      }
      await keysAreFresh(config.keysUri);
      return pipelineOf(await verifier.verify(token));
    } catch (error) {
      const reason = rejectionReason(error);
      if (reason === undefined) throw error;
      return { reason };
    }
  };
}

// Runs after the signature is verified.
function checkClaims(alg: string | undefined, payload: JwtPayload): void {
  // The library accepts any algorithm the key allows. GitHub signs with RS256 alone.
  if (alg !== "RS256") throw new ClaimRejected("algorithm");
  // The library checks `exp` only when there is one.
  if (payload.exp === undefined) throw new ClaimRejected("no-expiry");
  // The library accepts a token in the instant it expires. The CloudFront Function refuses it.
  if (payload.exp <= Date.now() / 1000) throw new ClaimRejected("expired");
  if (!isId(payload.repository_id) || !isId(payload.repository_owner_id)) {
    throw new ClaimRejected("repository");
  }
}

// The claim checks have already held both IDs to digits.
function pipelineOf(payload: JwtPayload): Pipeline | TokenRejection {
  const { repository_id, repository_owner_id, environment, run_id, sha } =
    payload;
  if (!isId(repository_id) || !isId(repository_owner_id)) {
    return { reason: "repository" };
  }
  return {
    repositoryId: repository_id,
    ownerId: repository_owner_id,
    environment: typeof environment === "string" ? environment : undefined,
    runId: isId(run_id) ? run_id : undefined,
    commit: typeof sha === "string" && COMMIT.test(sha) ? sha : undefined,
  };
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function rejectionReason(error: unknown): TokenRejectionReason | undefined {
  if (error instanceof ClaimRejected) return error.reason;
  return REJECTIONS.find(([type]) => error instanceof type)?.[1];
}
