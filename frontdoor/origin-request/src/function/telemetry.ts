// One log line per request, in the CloudFront Function's shape. Every value is a fixed code, an ID
// the platform derived, or a source location. Never the token, its claims, or a library's error
// text, which can quote a claim.

import type { UnexpectedErrorSummary } from "@repo/utils/describe-unexpected-error";

export type OriginRequestEventName =
  | "origin_request_token_verified"
  | "origin_request_token_missing"
  | "origin_request_token_invalid"
  | "origin_request_token_expired"
  | "origin_request_failed";

// The two IDs that join this line to the rest of the request: the trace ID every hop logs, and
// the request ID in CloudFront's own logs.
export interface RequestIds {
  readonly traceId: string;
  readonly requestId: string;
}

export function logOutcome(
  event: Exclude<OriginRequestEventName, "origin_request_failed">,
  ids: RequestIds,
  reason?: string,
): void {
  write("INFO", event, { ...ids, ...(reason === undefined ? {} : { reason }) });
}

export function logFailure(
  ids: RequestIds,
  error: UnexpectedErrorSummary,
): void {
  write("ERROR", "origin_request_failed", { ...ids, frames: error.frames });
}

function write(
  level: "INFO" | "ERROR",
  event: OriginRequestEventName,
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
