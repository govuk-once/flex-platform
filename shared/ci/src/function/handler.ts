import { traceIdFor } from "@repo/cloudfront-js-utils/trace-id-for";
import { CI_TOKEN_HEADER } from "@repo/shared-viewer-request";
import { describeUnexpectedError } from "@repo/utils/describe-unexpected-error";
import { heldValue } from "@repo/utils/held-value";
import { isTraceId } from "@repo/utils/is-trace-id";

import type { CiOptions } from "./options.ts";
import {
  forbidden,
  internalError,
  methodNotAllowed,
  notFound,
  unauthorized,
} from "./responses.ts";
import {
  createRouter,
  type MatchedRoute,
  type RouteDefinition,
} from "./router.ts";
import { ROUTES } from "./routes/index.ts";
import { logFailure, logOutcome, type RequestDetails } from "./telemetry.ts";
import type { Pipeline } from "./token.ts";
import type { FunctionUrlEvent, FunctionUrlResult } from "./types.ts";

export type { CiOptions } from "./options.ts";

// Verify the token, find the route, decide whether this pipeline may use it, and only then run the
// route's handler, which reads what it asks for. The token comes first, so a caller without one
// learns nothing of the routes. The decision comes before the request's body, so nothing a caller
// wrote is read, and nothing is signed or released, for a pipeline that isn't allowed. Every
// error is answered with a 500, so the runtime never prints one, whose text can hold a claim.
export function createCiHandler(
  options: CiOptions,
  routes: readonly RouteDefinition[] = ROUTES,
) {
  const router = createRouter(routes);

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

      const found = router(event.requestContext.http.method, event.rawPath);
      if (found.kind === "none") {
        logOutcome("ci_route_unknown", request(), caller);
        return notFound(traceId);
      }
      if (found.kind === "method") {
        logOutcome("ci_method_rejected", request(), caller);
        return methodNotAllowed(traceId, found.allowed);
      }

      const target = authorisedTarget(options, pipeline, found.match);
      if ("refusal" in target) {
        // Without the path's names, which are still only the caller's.
        logOutcome("ci_forbidden", request(), {
          ...caller,
          reason: target.refusal,
        });
        return forbidden(traceId);
      }

      // Allowed, so the path's names are the config's from here on.
      return await found.match.route.handle(options, {
        event,
        traceId,
        pipeline,
        target,
        params: found.match.params,
        details: { ...caller, ...target },
        request,
      });
    } catch (error) {
      logFailure(request(), describeUnexpectedError(error));
      return internalError(traceId);
    }
  };
}

// Whether the pipeline may act on the path's environment and domain. The router holds every
// route's path to naming both, so each is there.
function authorisedTarget(
  options: CiOptions,
  pipeline: Pipeline,
  { params }: MatchedRoute,
) {
  const target = {
    environment: heldValue(params, "environment"),
    domain: heldValue(params, "domain"),
  };
  const refusal = options.authorise(pipeline, target);
  return refusal === undefined ? target : { refusal };
}

// The trace ID the CloudFront Function set, so every log line for the request carries the same
// one. That function removes any `x-correlation-id` a caller sent before setting its own. A
// caller in the function's own account that IAM lets call the URL directly could send any, so
// the header is taken only when it has a trace ID's form, which holds no text of a caller's.
// Anything else is replaced with one made from Lambda's ID for the request.
function requestTraceId(event: FunctionUrlEvent, nowMs: number): string {
  const correlationId = event.headers["x-correlation-id"];
  if (correlationId !== undefined && isTraceId(correlationId)) {
    return correlationId;
  }
  return traceIdFor(event.requestContext.requestId, nowMs / 1000);
}
