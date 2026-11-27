import type { CloudFrontRequest } from "@repo/cloudfront-function";
import { isRepeated } from "@repo/cloudfront-function";
import { isSha256Hex } from "@repo/cloudfront-js-utils/is-sha256-hex";

const CONTENT_HASH_HEADER = "x-amz-content-sha256";

// Whether a request names its body's SHA-256, once. CloudFront signs each request for the
// origin, a Lambda function URL, and hashes no body: it signs the hash this header holds, and
// Lambda refuses a request whose body has another. Without the header the request would reach
// Lambda only to be refused, with nothing to say why. Whether the hash is the body's is for
// Lambda: a function can't see a body.
export function hasContentHash(request: CloudFrontRequest): boolean {
  const hash = request.headers[CONTENT_HASH_HEADER];
  return hash !== undefined && !isRepeated(hash) && isSha256Hex(hash.value);
}
