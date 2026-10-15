// One log line per request, in a fixed shape. Function logs all land in us-east-1, so a metric
// filter can count each event.

export type ViewerRequestEventName =
  | "viewer_request_token_validated"
  | "viewer_request_method_rejected"
  | "viewer_request_token_missing"
  | "viewer_request_token_invalid"
  | "viewer_request_token_expired"
  | "viewer_request_path_rejected"
  | "viewer_request_content_type_rejected";

// The two IDs that join this line to the rest of the request: the trace ID every later hop logs,
// and the request ID in CloudFront's own logs. Only this line holds both.
export interface RequestIds {
  readonly traceId: string;
  readonly requestId: string;
}

// Details are the IDs and a fixed reason code, never text from the request.
export function logOutcome(
  event: ViewerRequestEventName,
  ids: RequestIds,
  reason?: string,
): void {
  const details: Record<string, string> = {
    traceId: ids.traceId,
    requestId: ids.requestId,
  };
  if (reason !== undefined) details.reason = reason;
  console.log(
    JSON.stringify({
      level: "INFO",
      message: "telemetry",
      telemetry: { event, details },
    }),
  );
}
