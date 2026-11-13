import type { CloudFrontRequest } from "./event.ts";
import { isRepeated } from "./repeated.ts";

const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

// The headers that describe a body, each read below.
const BODY_HEADERS = ["content-length", "content-type", "transfer-encoding"];

// Methods that carry a body. HTTP/2 and HTTP/3 needn't announce one with content-length or
// transfer-encoding, so these need JSON whether or not a body is announced.
const BODY_METHODS = ["PATCH", "POST", "PUT"];

// Whether a request's body, where it has or must have one, is JSON, with each header that
// describes it sent once. A request with no body to speak of passes.
export function isJsonRequest(request: CloudFrontRequest): boolean {
  if (BODY_HEADERS.some((name) => isRepeated(request.headers[name]))) {
    return false;
  }
  return !expectsBody(request) || isJson(request);
}

// A function can't see the body, only the method and the headers that announce one.
function expectsBody(request: CloudFrontRequest): boolean {
  if (BODY_METHODS.includes(request.method)) return true;
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
