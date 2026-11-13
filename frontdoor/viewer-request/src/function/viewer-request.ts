import type {
  CloudFrontRequest,
  CloudFrontResponse,
  ViewerRequestEvent,
} from "@repo/cloudfront-function";
import {
  isJsonRequest,
  isRepeated,
  methodNotAllowed,
  notFound,
  unauthorized,
  unsupportedMediaType,
} from "@repo/cloudfront-function";
import { traceIdFor } from "@repo/cloudfront-js-utils/trace-id-for";

import { isRoutable } from "./path.ts";
import { logEvent } from "./telemetry.ts";
import { checkToken } from "./token.ts";
import type { ViewerRequestConfig } from "./types.ts";

// Headers only the platform sets. A caller's copy is removed before anything reads it.
const PLATFORM_HEADER_PREFIX = "x-flex-";

// Trace context a caller could send to pick the trace, or force every request to be sampled.
const CALLER_TRACE_HEADERS = ["traceparent", "tracestate", "x-amzn-trace-id"];

// The methods the platform serves. CloudFront itself allows every method, so this is where the rest
// are refused.
const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

// The method is checked first, since its answer says nothing about the caller or the paths. The
// token is checked before the path, so a request without a valid token gets a 401 whatever its
// path, and learns nothing about which paths exist.
export function viewerRequest(
  event: ViewerRequestEvent,
  config: ViewerRequestConfig,
  nowSeconds: number,
): CloudFrontRequest | CloudFrontResponse {
  const request = event.request;
  const headers = request.headers;

  const requestId = event.context.requestId;
  const traceId = traceIdFor(requestId, nowSeconds);
  // forEach, not for...of, which the runtime lacks and esbuild can't rewrite for it.
  Object.keys(headers).forEach((name) => {
    if (
      name.startsWith(PLATFORM_HEADER_PREFIX) ||
      CALLER_TRACE_HEADERS.includes(name)
    ) {
      delete headers[name];
    }
  });
  // The edge's ID for the request, which the app reads and every later hop logs. The edge sends
  // no X-Amzn-Trace-Id: API Gateway rewrites that header before it checks a signature, so the
  // X-Ray trace starts there.
  headers["x-correlation-id"] = { value: traceId };
  const ids = { traceId, requestId };

  if (!ALLOWED_METHODS.includes(request.method)) {
    logEvent("viewer_request_method_rejected", ids);
    return methodNotAllowed(traceId, ALLOWED_METHODS);
  }

  const rejection = isRepeated(headers.authorization)
    ? ({ event: "viewer_request_token_invalid", reason: "repeated" } as const)
    : checkToken(headers.authorization?.value, config.issuers, nowSeconds);
  if (rejection) {
    logEvent(rejection.event, ids, rejection.reason);
    return unauthorized(traceId);
  }

  if (!isRoutable(request.uri)) {
    logEvent("viewer_request_path_rejected", ids);
    return notFound(traceId);
  }

  if (!isJsonRequest(request)) {
    logEvent("viewer_request_content_type_rejected", ids);
    return unsupportedMediaType(traceId);
  }

  logEvent("viewer_request_token_validated", ids);
  return request;
}
