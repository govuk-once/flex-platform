import type {
  CloudFrontRequest,
  CloudFrontResponse,
  ViewerRequestEvent,
} from "@repo/cloudfront-function";
import {
  badRequest,
  isJsonRequest,
  isRepeated,
  methodNotAllowed,
  notFound,
  removePlatformHeaders,
  unauthorized,
  unsupportedMediaType,
} from "@repo/cloudfront-function";
import { traceIdFor } from "@repo/cloudfront-js-utils/trace-id-for";

import { isCiPath } from "./ci-path.ts";
import { hasContentHash } from "./content-hash.ts";
import { logEvent } from "./telemetry.ts";
import { checkToken, CI_TOKEN_HEADER } from "./token.ts";
import type { ViewerRequestConfig } from "./types.ts";

// Every route a pipeline calls is a POST.
const ALLOWED_METHODS = ["POST"];

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
  // The token's header is the one x-flex- header a caller sends. It is checked below.
  removePlatformHeaders(headers, [CI_TOKEN_HEADER]);
  // The edge's ID for the request, which the caller reads and every later hop logs.
  headers["x-correlation-id"] = { value: traceId };
  const ids = { traceId, requestId };

  if (!ALLOWED_METHODS.includes(request.method)) {
    logEvent("viewer_request_method_rejected", ids);
    return methodNotAllowed(traceId, ALLOWED_METHODS);
  }

  const token = headers[CI_TOKEN_HEADER];
  const rejection = isRepeated(token)
    ? ({ event: "viewer_request_token_invalid", reason: "repeated" } as const)
    : checkToken(token?.value, config, nowSeconds);
  if (rejection) {
    logEvent(rejection.event, ids, rejection.reason);
    return unauthorized(traceId);
  }

  if (!isCiPath(request.uri)) {
    logEvent("viewer_request_path_rejected", ids);
    return notFound(traceId);
  }

  if (!isJsonRequest(request)) {
    logEvent("viewer_request_content_type_rejected", ids);
    return unsupportedMediaType(traceId);
  }

  if (!hasContentHash(request)) {
    logEvent("viewer_request_content_hash_rejected", ids);
    return badRequest(traceId);
  }

  logEvent("viewer_request_token_validated", ids);
  return request;
}
