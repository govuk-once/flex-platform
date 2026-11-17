import type { FunctionUrlResult } from "./types.ts";

// The CloudFront Function's own 401, for a token that is missing or fails verification.
export function unauthorized(traceId: string): FunctionUrlResult {
  return answer(401, "Unauthorized", "auth_error", traceId);
}

// One answer for every pipeline that is not allowed, whatever the reason.
export function forbidden(traceId: string): FunctionUrlResult {
  return answer(403, "Forbidden", "auth_error", traceId);
}

export function notFound(traceId: string): FunctionUrlResult {
  return answer(404, "Not found", "client_error", traceId);
}

export function methodNotAllowed(
  traceId: string,
  allowed: readonly string[],
): FunctionUrlResult {
  return answer(405, "Method not allowed", "client_error", traceId, {
    allow: allowed.join(", "),
  });
}

// Fail closed: anything that goes wrong ends here.
export function internalError(traceId: string): FunctionUrlResult {
  return answer(500, "Internal server error", "server_error", traceId);
}

export function notImplemented(traceId: string): FunctionUrlResult {
  return answer(501, "Not implemented", "server_error", traceId);
}

function answer(
  statusCode: number,
  message: string,
  type: string,
  traceId: string,
  extra: Record<string, string> = {},
): FunctionUrlResult {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "x-correlation-id": traceId,
      "x-rejected-by": "pipeline-api",
      ...extra,
    },
    body: JSON.stringify({ message, type }),
  };
}
