import { isRoutable } from "./path.ts";
import { notFound, unauthorized, unsupportedMediaType } from "./responses.ts";
import { logOutcome } from "./telemetry.ts";
import { checkToken } from "./token.ts";
import { traceIdFor } from "./trace-id.ts";
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
const CALLER_TRACE_HEADERS = ["traceparent", "tracestate"];

const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

// The headers that describe a body, each read below.
const BODY_HEADERS = ["content-length", "content-type", "transfer-encoding"];

// Methods that carry a body. HTTP/2 and HTTP/3 needn't announce one with content-length or
// transfer-encoding, so these need JSON whether or not a body is announced.
const BODY_METHODS = ["PATCH", "POST", "PUT"];

// The token is checked before the path, so a request without a valid token gets a 401 whatever its
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
  // No Parent: the edge records no span, so API Gateway's span starts the tree.
  headers["x-amzn-trace-id"] = { value: "Root=" + traceId };
  // The header the app reads. It carries the same ID.
  headers["x-correlation-id"] = { value: traceId };
  const ids = { traceId, requestId };

  const rejection = isRepeated(headers.authorization)
    ? ({ event: "cff_token_invalid", reason: "repeated" } as const)
    : checkToken(headers.authorization?.value, config.issuers, nowSeconds);
  if (rejection) {
    logOutcome(rejection.event, ids, rejection.reason);
    return unauthorized(traceId);
  }

  if (!isRoutable(request.uri)) {
    logOutcome("cff_path_rejected", ids);
    return notFound(traceId);
  }

  if (
    BODY_HEADERS.some((name) => isRepeated(headers[name])) ||
    (expectsBody(request) && !isJson(request))
  ) {
    logOutcome("cff_content_type_rejected", ids);
    return unsupportedMediaType(traceId);
  }

  logOutcome("cff_token_validated", ids);
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
