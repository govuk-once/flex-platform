import type { SignedUpload } from "./sign-upload.ts";
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

export function badRequest(traceId: string): FunctionUrlResult {
  return answer(400, "Bad request", "client_error", traceId);
}

// For a pipeline that is allowed, so it is told why: the environment takes its code by promotion.
export function uploadsNotAccepted(traceId: string): FunctionUrlResult {
  return answer(
    409,
    "This environment takes no uploads",
    "client_error",
    traceId,
  );
}

// Never stored: the address is the pipeline's alone, and good for five minutes.
export function uploadSigned(
  traceId: string,
  upload: SignedUpload,
): FunctionUrlResult {
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-correlation-id": traceId,
    },
    body: JSON.stringify({
      method: "PUT",
      url: upload.url,
      headers: upload.headers,
      expiresInSeconds: upload.expiresInSeconds,
    }),
  };
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
