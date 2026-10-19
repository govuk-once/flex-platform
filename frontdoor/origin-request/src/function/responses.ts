import type { CloudFrontHeaders, CloudFrontResultResponse } from "./types.ts";

// The app relies on this 401 exactly, the CloudFront Function's own, so it never changes.
export function unauthorized(traceId: string): CloudFrontResultResponse {
  return rejection("401", "Unauthorized", "auth_error", traceId);
}

// Fail closed: anything that goes wrong ends here, never at the origin.
export function internalError(traceId: string): CloudFrontResultResponse {
  return rejection(
    "500",
    "Internal server error",
    "server_error",
    traceId,
    "Internal Server Error",
  );
}

// The answer to a verified token, until routing forwards the request instead. Fixed
// fields only: the region also shows what share of traffic runs in London.
export function verified(
  traceId: string,
  runtime: { readonly region: string; readonly functionVersion: string },
): CloudFrontResultResponse {
  return {
    status: "200",
    statusDescription: "OK",
    headers: headers(traceId, {}),
    body: JSON.stringify({
      outcome: "verified",
      traceId,
      region: runtime.region,
      functionVersion: runtime.functionVersion,
    }),
    bodyEncoding: "text",
  };
}

function rejection(
  status: string,
  message: string,
  type: string,
  traceId: string,
  statusDescription = message,
): CloudFrontResultResponse {
  return {
    status,
    statusDescription,
    headers: headers(traceId, {
      "x-rejected-by": [{ key: "X-Rejected-By", value: "lambda-edge" }],
    }),
    body: JSON.stringify({ message, type }),
    bodyEncoding: "text",
  };
}

function headers(traceId: string, extra: CloudFrontHeaders): CloudFrontHeaders {
  return {
    "content-type": [{ key: "Content-Type", value: "application/json" }],
    "x-correlation-id": [{ key: "X-Correlation-Id", value: traceId }],
    ...extra,
  };
}
