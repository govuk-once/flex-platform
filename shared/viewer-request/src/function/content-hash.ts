import type { CloudFrontRequest } from "@repo/cloudfront-function";
import { isRepeated } from "@repo/cloudfront-function";

const CONTENT_HASH_HEADER = "x-amz-content-sha256";

// A SHA-256 as SigV4 writes it: 64 hex digits, in lowercase.
const SHA256_HEX = /^[0-9a-f]{64}$/;

// Whether a request names its body's SHA-256, once. CloudFront signs each request for the
// origin, a Lambda function URL, and hashes no body: it signs the hash this header holds, and
// Lambda refuses a request whose body has another. Without the header the request would reach
// Lambda only to be refused, with nothing to say why. Whether the hash is the body's is for
// Lambda: a function can't see a body.
export function hasContentHash(request: CloudFrontRequest): boolean {
  const hash = request.headers[CONTENT_HASH_HEADER];
  return hash !== undefined && !isRepeated(hash) && SHA256_HEX.test(hash.value);
}
