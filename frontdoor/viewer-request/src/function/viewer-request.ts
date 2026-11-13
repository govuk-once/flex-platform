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
  removePlatformHeaders,
  unauthorized,
  unsupportedMediaType,
} from "@repo/cloudfront-function";
import { traceIdFor } from "@repo/cloudfront-js-utils/trace-id-for";
import { ALLOWED_METHODS, isRoutable } from "@repo/frontdoor-shared";

import { logEvent } from "./telemetry.ts";
import { checkToken } from "./token.ts";
import type { ViewerRequestConfig } from "./types.ts";

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
  // The app sends no x-flex- header, so a caller's are all removed.
  removePlatformHeaders(headers, []);
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
