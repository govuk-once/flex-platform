import { traceIdFor } from "@repo/cloudfront-js-utils/trace-id-for";
import { CI_TOKEN_HEADER } from "@repo/shared-viewer-request/token-header";
import { describeUnexpectedError } from "@repo/utils/describe-unexpected-error";

import type { Authorise, TakesUploads } from "./authorise.ts";
import { bundleKey, bundleOf } from "./bundle.ts";
import {
  badRequest,
  forbidden,
  internalError,
  methodNotAllowed,
  notFound,
  unauthorized,
  uploadSigned,
  uploadsNotAccepted,
} from "./responses.ts";
import { ALLOWED_METHODS, uploadTarget } from "./route.ts";
import type { SignUpload } from "./sign-upload.ts";
import { logFailure, logOutcome, type RequestDetails } from "./telemetry.ts";
import type { VerifyToken } from "./token.ts";
import type { FunctionUrlEvent, FunctionUrlResult } from "./types.ts";

export interface CiOptions {
  readonly verifyToken: VerifyToken;
  readonly authorise: Authorise;
  readonly takesUploads: TakesUploads;
  readonly signUpload: SignUpload;
  /** The time now, in milliseconds. */
  readonly now: () => number;
}

const TRACE_ID = /^1-[0-9a-f]{8}-[0-9a-f]{24}$/;

// Verify the token, find the route, decide whether this pipeline may use it, and only then read
// what it asks for. The token comes first, so a caller without one learns nothing of the routes.
// The decision comes before the request's body, so nothing a caller wrote is read, and nothing is
// signed, for a pipeline that isn't allowed. Every error is answered with a 500, so the runtime
// never prints one, whose text can hold a claim.
export function createCiHandler(options: CiOptions) {
  return async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
    const started = options.now();
    const { requestId } = event.requestContext;
    const traceId = requestTraceId(event, started);
    const request = (): RequestDetails => ({
      traceId,
      requestId,
      durationMs: options.now() - started,
    });

    try {
      const token = event.headers[CI_TOKEN_HEADER];
      if (token === undefined || token === "") {
        logOutcome("ci_token_missing", request());
        return unauthorized(traceId);
      }

      const pipeline = await options.verifyToken(token);
      if ("reason" in pipeline) {
        const outcome =
          pipeline.reason === "expired"
            ? "ci_token_expired"
            : "ci_token_invalid";
        logOutcome(outcome, request(), { reason: pipeline.reason });
        return unauthorized(traceId);
      }
      const caller = {
        repositoryId: pipeline.repositoryId,
        ownerId: pipeline.ownerId,
        runId: pipeline.runId,
        commit: pipeline.commit,
      };

      // The CloudFront Function's check again, since nothing here should rely on it.
      if (!ALLOWED_METHODS.includes(event.requestContext.http.method)) {
        logOutcome("ci_method_rejected", request(), caller);
        return methodNotAllowed(traceId, ALLOWED_METHODS);
      }
      const target = uploadTarget(event.rawPath);
      if (target === undefined) {
        logOutcome("ci_route_unknown", request(), caller);
        return notFound(traceId);
      }

      const refusal = options.authorise(pipeline, target);
      if (refusal !== undefined) {
        // Without the path's names, which are still only the caller's.
        logOutcome("ci_forbidden", request(), { ...caller, reason: refusal });
        return forbidden(traceId);
      }

      // Allowed, so the path's names are the config's from here on.
      const allowed = { ...caller, ...target };

      if (!options.takesUploads(target.environment)) {
        logOutcome("ci_upload_not_accepted", request(), allowed);
        return uploadsNotAccepted(traceId);
      }
      const bundle = bundleOf(event);
      if (typeof bundle === "string") {
        logOutcome("ci_upload_invalid", request(), {
          ...allowed,
          reason: bundle,
        });
        return badRequest(traceId);
      }

      const key = bundleKey(target.domain, bundle.sha256);
      const upload = await options.signUpload(key, bundle);
      logOutcome("ci_upload_signed", request(), {
        ...allowed,
        key,
        size: bundle.size,
      });
      return uploadSigned(traceId, upload);
    } catch (error) {
      logFailure(request(), describeUnexpectedError(error));
      return internalError(traceId);
    }
  };
}

// The trace ID the CloudFront Function set, so every log line for the request carries the same
// one. That function removes any `x-correlation-id` a caller sent before setting its own. A
// caller in the function's own account that IAM lets call the URL directly could send any, so
// the header is taken only when it has a trace ID's form, which holds no text of a caller's.
// Anything else is replaced with one made from Lambda's ID for the request.
function requestTraceId(event: FunctionUrlEvent, nowMs: number): string {
  const correlationId = event.headers["x-correlation-id"];
  if (correlationId !== undefined && TRACE_ID.test(correlationId)) {
    return correlationId;
  }
  return traceIdFor(event.requestContext.requestId, nowMs / 1000);
}
