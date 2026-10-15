// One log line per request, in the CloudFront Function's shape. Every value is a fixed code, an ID
// the platform derived, or a source location. Never the token, its claims, or a library's error
// text, which can quote a claim.

import type { UnexpectedErrorSummary } from "@repo/utils/describe-unexpected-error";

export type OriginRequestEventName =
  | "lae_forwarded"
  | "lae_route_unknown"
  | "lae_token_missing"
  | "lae_token_invalid"
  | "lae_token_expired"
  | "lae_failed";

// The two IDs that join this line to the rest of the request: the trace ID every hop logs, and
// the request ID in CloudFront's own logs.
export interface RequestIds {
  readonly traceId: string;
  readonly requestId: string;
}

// A reason is a fixed code. A domain is a name from the config, never the caller's path.
export interface OutcomeDetails {
  readonly reason?: string;
  readonly domain?: string;
}

export function logOutcome(
  event: Exclude<OriginRequestEventName, "lae_failed">,
  ids: RequestIds,
  details: OutcomeDetails = {},
): void {
  write("INFO", event, { ...ids, ...details });
}

export function logFailure(
  ids: RequestIds,
  error: UnexpectedErrorSummary,
): void {
  write("ERROR", "lae_failed", { ...ids, frames: error.frames });
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
