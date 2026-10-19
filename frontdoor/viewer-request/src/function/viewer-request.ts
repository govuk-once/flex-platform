import { traceIdFor } from "@repo/frontdoor-shared";

import { isRoutable } from "./path.ts";
import {
  methodNotAllowed,
  notFound,
  unauthorized,
  unsupportedMediaType,
} from "./responses.ts";
import { logOutcome } from "./telemetry.ts";
import { checkToken } from "./token.ts";
import type {
  CloudFrontRequest,
  CloudFrontResponse,
  FieldValue,
  ViewerRequestConfig,
  ViewerRequestEvent,
} from "./types.ts";

// Headers only the platform sets. A caller's copy is removed before anything reads it.
const PLATFORM_HEADER_PREFIX = "x-flex-";

// Trace context a caller could send to pick the trace, or force every request to be sampled.
const CALLER_TRACE_HEADERS = ["traceparent", "tracestate", "x-amzn-trace-id"];

const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

// The headers that describe a body, each read below.
const BODY_HEADERS = ["content-length", "content-type", "transfer-encoding"];

// The methods the platform serves. CloudFront itself allows every method, so this is where the rest
// are refused.
const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

// Methods that carry a body. HTTP/2 and HTTP/3 needn't announce one with content-length or
// transfer-encoding, so these need JSON whether or not a body is announced.
const BODY_METHODS = ["PATCH", "POST", "PUT"];

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
  const names = Object.keys(headers);
  // Index loops throughout: the runtime has no for...of, and esbuild can't rewrite one for it.
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    if (
      name.indexOf(PLATFORM_HEADER_PREFIX) === 0 ||
      CALLER_TRACE_HEADERS.indexOf(name) !== -1
    ) {
      delete headers[name];
    }
  }
  // The edge's ID for the request, which the app reads and every later hop logs. The edge sends
  // no X-Amzn-Trace-Id: API Gateway rewrites that header before it checks a signature, so the
  // X-Ray trace starts there.
  headers["x-correlation-id"] = { value: traceId };
  const ids = { traceId, requestId };

  if (ALLOWED_METHODS.indexOf(request.method) === -1) {
    logOutcome("viewer_request_method_rejected", ids);
    return methodNotAllowed(traceId, ALLOWED_METHODS);
  }

  const rejection = isRepeated(headers.authorization)
    ? ({ event: "viewer_request_token_invalid", reason: "repeated" } as const)
    : checkToken(headers.authorization?.value, config.issuers, nowSeconds);
  if (rejection) {
    logOutcome(rejection.event, ids, rejection.reason);
    return unauthorized(traceId);
  }

  if (!isRoutable(request.uri)) {
    logOutcome("viewer_request_path_rejected", ids);
    return notFound(traceId);
  }

  if (
    BODY_HEADERS.some((name) => isRepeated(headers[name])) ||
    (expectsBody(request) && !isJson(request))
  ) {
    logOutcome("viewer_request_content_type_rejected", ids);
    return unsupportedMediaType(traceId);
  }

  logOutcome("viewer_request_token_validated", ids);
  return request;
}

// A repeated header keeps only its first value in `value`. The function reads that, but a later
// step might read another, so every header it reads must have one value.
function isRepeated(header: FieldValue | undefined): boolean {
  return header?.multiValue !== undefined && header.multiValue.length > 1;
}

// The function can't see the body, only the method and the headers that announce one.
function expectsBody(request: CloudFrontRequest): boolean {
  if (BODY_METHODS.indexOf(request.method) !== -1) return true;
  const length = request.headers["content-length"]?.value;
  return (
    (length !== undefined && length !== "0") ||
    request.headers["transfer-encoding"] !== undefined
  );
}

function isJson(request: CloudFrontRequest): boolean {
  const contentType = request.headers["content-type"]?.value;
  return contentType !== undefined && JSON_CONTENT_TYPE.test(contentType);
}
