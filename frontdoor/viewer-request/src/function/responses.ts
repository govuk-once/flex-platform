import type { CloudFrontResponse } from "./types.ts";

// What kind of failure it is, which tells the app how to handle it. The status says which one.
type ErrorType = "auth_error" | "client_error";

export function methodNotAllowed(
  traceId: string,
  allowed: readonly string[],
): CloudFrontResponse {
  const response = rejection(
    405,
    "Method not allowed",
    "client_error",
    traceId,
  );
  response.headers.allow = { value: allowed.join(", ") };
  return response;
}

// The app relies on this 401 exactly, so it never changes.
export function unauthorized(traceId: string): CloudFrontResponse {
  return rejection(401, "Unauthorized", "auth_error", traceId);
}

export function notFound(traceId: string): CloudFrontResponse {
  return rejection(404, "Not found", "client_error", traceId);
}

export function unsupportedMediaType(traceId: string): CloudFrontResponse {
  return rejection(415, "Unsupported media type", "client_error", traceId);
}

function rejection(
  statusCode: number,
  message: string,
  type: ErrorType,
  traceId: string,
): CloudFrontResponse {
  return {
    statusCode,
    headers: {
      "content-type": { value: "application/json" },
      "x-rejected-by": { value: "cloudfront-function" },
      "x-correlation-id": { value: traceId },
    },
    body: { encoding: "text", data: JSON.stringify({ message, type }) },
  };
}
