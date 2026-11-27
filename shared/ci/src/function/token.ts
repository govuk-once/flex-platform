// Verifies a pipeline's token. The CloudFront Function checked its shape. This is what proves it:
// the signature against the issuer's published keys, and every claim the platform relies on.
//
// Anyone with a GitHub repository can have GitHub sign a token for this audience. So a verified
// token says only which repository's pipeline is calling, and what it may do is decided after, by
// the repository's and its owner's IDs. Never by `sub`, whose format a repository's admin sets.

import {
  createJwtVerifier,
  type JwtRejectionReason,
} from "@repo/lambda-function";
import type { Fetcher } from "aws-jwt-verify/https";
import type { JwtPayload } from "aws-jwt-verify/jwt-model";

import type { CiConfig } from "./types.ts";

export { KEYS_BACKOFF_MS, KEYS_MAX_AGE_MS } from "@repo/lambda-function";

// Why a token was refused, as a fixed code. Never text from the token or from the library's
// errors, which can hold a claim's value.
export type TokenRejectionReason = JwtRejectionReason | "repository";

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

const ID = /^\d{1,20}$/;

// A commit's SHA-1 or SHA-256, in hex.
const COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

// `fetcher` replaces the network in tests.
export function createTokenVerifier(
  config: Pick<CiConfig, "issuer" | "keysUri" | "audience">,
  fetcher?: Fetcher,
): VerifyToken {
  const verify = createJwtVerifier<"repository">(
    [
      {
        issuer: config.issuer,
        audience: config.audience,
        // Named, since the library's default for an issuer is not where GitHub publishes its keys.
        keysUri: config.keysUri,
        checkClaims: (payload, reject) => {
          if (
            !isId(payload.repository_id) ||
            !isId(payload.repository_owner_id)
          ) {
            reject("repository");
          }
        },
      },
    ],
    fetcher,
  );

  return async (token) => {
    if (token.length > MAX_TOKEN_LENGTH) return { reason: "malformed" };
    const verified = await verify(token);
    return "reason" in verified ? verified : pipelineOf(verified.payload);
  };
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
