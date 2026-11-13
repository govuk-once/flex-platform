import { logOutcome, type RequestIds } from "@repo/cloudfront-function";

// Every event the function logs, one per request.
export type ViewerRequestEventName =
  | "viewer_request_token_validated"
  | "viewer_request_method_rejected"
  | "viewer_request_token_missing"
  | "viewer_request_token_invalid"
  | "viewer_request_token_expired"
  | "viewer_request_path_rejected"
  | "viewer_request_content_type_rejected";

// Holds each line to one of the function's own events.
export function logEvent(
  event: ViewerRequestEventName,
  ids: RequestIds,
  reason?: string,
): void {
  logOutcome(event, ids, reason);
}
