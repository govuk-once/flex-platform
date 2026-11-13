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

export function methodNotAllowed(
  traceId: string,
  allowed: readonly string[],
): CloudFrontResultResponse {
  return rejection(
    "405",
    "Method not allowed",
    "client_error",
    traceId,
    "Method not allowed",
    { allow: [{ key: "Allow", value: allowed.join(", ") }] },
  );
}

export function unsupportedMediaType(
  traceId: string,
): CloudFrontResultResponse {
  return rejection("415", "Unsupported media type", "client_error", traceId);
}

// A query no signature can cover, so nothing is forwarded. The caller's fault, after the token is
// verified.
export function badRequest(traceId: string): CloudFrontResultResponse {
  return rejection("400", "Bad request", "client_error", traceId);
}

// No domain by that name. The CloudFront Function's own 404, after the token is verified.
export function notFound(traceId: string): CloudFrontResultResponse {
  return rejection("404", "Not found", "client_error", traceId);
}

function rejection(
  status: string,
  message: string,
  type: string,
  traceId: string,
  statusDescription = message,
  extra: CloudFrontHeaders = {},
): CloudFrontResultResponse {
  return {
    status,
    statusDescription,
    headers: headers(traceId, {
      "x-rejected-by": [{ key: "X-Rejected-By", value: "lambda-edge" }],
      ...extra,
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
