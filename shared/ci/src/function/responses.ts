import type { ReleaseRecord } from "@repo/shared-release";

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
export function notAccepted(
  traceId: string,
  action: "uploads" | "releases",
): FunctionUrlResult {
  return answer(
    409,
    `This environment takes no ${action}`,
    "client_error",
    traceId,
  );
}

// For a pipeline that is allowed, so it is told why: there is no version to release, or no bundle
// for it.
export function versionUnknown(traceId: string): FunctionUrlResult {
  return answer(
    409,
    "No bundle with this version has been uploaded",
    "client_error",
    traceId,
  );
}

// For a pipeline that is allowed, so it is told why: a version names one bundle, and never
// another once it is recorded.
export function versionTaken(traceId: string): FunctionUrlResult {
  return answer(
    409,
    "This version is already a different bundle",
    "client_error",
    traceId,
  );
}

// The release is queued, not done: the worker creates or updates the function, and moves `live`.
export function releaseQueued(
  traceId: string,
  release: {
    releaseId: string;
    environment: string;
    domain: string;
    version: string;
    sha256: string;
  },
): FunctionUrlResult {
  return json(202, traceId, release);
}

// How a release went, as the table has it now, which changes until it is final.
export function releaseStatus(
  traceId: string,
  record: ReleaseRecord,
): FunctionUrlResult {
  return json(
    200,
    traceId,
    {
      releaseId: record.id,
      environment: record.environment,
      domain: record.domain,
      version: record.version,
      sha256: record.sha256,
      status: record.status,
      requestedAt: new Date(record.requestedAt).toISOString(),
      updatedAt: new Date(record.updatedAt).toISOString(),
      attempts: record.attempts,
      ...(record.step !== undefined && { step: record.step }),
      ...(record.reason !== undefined && { reason: record.reason }),
      ...(record.functionVersion !== undefined && {
        functionVersion: record.functionVersion,
      }),
      ...(record.created !== undefined && { created: record.created }),
      ...(record.moved !== undefined && { moved: record.moved }),
      ...(record.runId !== undefined && { runId: record.runId }),
      ...(record.commit !== undefined && { commit: record.commit }),
    },
    NO_STORE,
  );
}

// The bundle is in the bucket already, so there is nothing to upload.
export function uploadPresent(
  traceId: string,
  upload: { version: string; sha256: string },
): FunctionUrlResult {
  return json(200, traceId, {
    version: upload.version,
    sha256: upload.sha256,
    uploaded: true,
  });
}

// Never stored: the address is the pipeline's alone, and good for five minutes.
export function uploadSigned(
  traceId: string,
  upload: SignedUpload,
): FunctionUrlResult {
  return json(
    200,
    traceId,
    {
      uploaded: false,
      method: "PUT",
      url: upload.url,
      headers: upload.headers,
      expiresInSeconds: upload.expiresInSeconds,
    },
    NO_STORE,
  );
}

// An answer that changes, so no cache along the way keeps it.
const NO_STORE = { "cache-control": "no-store" };

function answer(
  statusCode: number,
  message: string,
  type: string,
  traceId: string,
  extra: Record<string, string> = {},
): FunctionUrlResult {
  return json(
    statusCode,
    traceId,
    { message, type },
    { "x-rejected-by": "pipeline-api", ...extra },
  );
}

function json(
  statusCode: number,
  traceId: string,
  body: unknown,
  extra: Record<string, string> = {},
): FunctionUrlResult {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "x-correlation-id": traceId,
      ...extra,
    },
    body: JSON.stringify(body),
  };
}
