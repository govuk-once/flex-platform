import type { CloudFrontResponse } from "./types.ts";

// The app relies on this 401 exactly, so it never changes.
export function unauthorized(traceId: string): CloudFrontResponse {
  return rejection(401, "Unauthorized", "auth_error", traceId);
}

export function notFound(traceId: string): CloudFrontResponse {
  return rejection(404, "Not Found", "not_found", traceId);
}

export function unsupportedMediaType(traceId: string): CloudFrontResponse {
  return rejection(
    415,
    "Unsupported Media Type",
    "unsupported_media_type",
    traceId,
  );
}

function rejection(
  statusCode: number,
  message: string,
  type: string,
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
