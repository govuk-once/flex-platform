// One log line per request, in the shape of the CloudFront Function's. Every value is a fixed
// code, an ID the platform or GitHub issued, a name from the config, a bundle's hash and length
// once both are checked, or a source location. Never the token, a claim a repository's admin can
// write, the caller's path, the address an upload is signed for, or a library's error text, which
// can quote a claim.

import type { UnexpectedErrorSummary } from "@repo/utils/describe-unexpected-error";

export type CiEventName =
  | "ci_token_missing"
  | "ci_token_invalid"
  | "ci_token_expired"
  | "ci_method_rejected"
  | "ci_route_unknown"
  | "ci_forbidden"
  | "ci_upload_not_accepted"
  | "ci_upload_invalid"
  | "ci_upload_signed"
  | "ci_failed";

// What joins this line to the rest of the request: the trace ID every hop logs, and Lambda's own
// ID for the request. The duration is the function's own time on it.
export interface RequestDetails {
  readonly traceId: string;
  readonly requestId: string;
  readonly durationMs: number;
}

// A reason is a fixed code. The IDs are GitHub's, from a verified token. The environment and
// domain are there only once they are names the config holds.
export interface OutcomeDetails {
  readonly reason?: string;
  readonly repositoryId?: string;
  readonly ownerId?: string;
  /** A token may hold none. */
  readonly runId?: string | undefined;
  /** The commit the job runs for. A token may hold none. */
  readonly commit?: string | undefined;
  readonly environment?: string;
  readonly domain?: string;
  /** The bundle's key in the bucket, which holds its domain and its hash. */
  readonly key?: string;
  readonly size?: number;
}

export function logOutcome(
  event: Exclude<CiEventName, "ci_failed">,
  request: RequestDetails,
  details: OutcomeDetails = {},
): void {
  write("INFO", event, { ...request, ...details });
}

export function logFailure(
  request: RequestDetails,
  error: UnexpectedErrorSummary,
): void {
  write("ERROR", "ci_failed", { ...request, frames: error.frames });
}

function write(
  level: "INFO" | "ERROR",
  event: CiEventName,
  details: Record<string, unknown>,
): void {
  console.log(
    JSON.stringify({
      level,
      message: "telemetry",
      telemetry: { event, details },
    }),
  );
}
