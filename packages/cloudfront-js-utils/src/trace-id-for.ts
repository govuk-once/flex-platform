// The CloudFront Functions runtime provides this module by this name, as a default import.
import crypto from "crypto";

// An X-Ray trace ID, `1-<start, epoch seconds in hex>-<24 hex>`. The same 32 hex digits are a
// W3C trace ID too. The 24 come from CloudFront's request ID, so a request always has the same
// trace ID, and no caller chooses it.
export function traceIdFor(requestId: string, nowSeconds: number): string {
  const start = ("00000000" + Math.floor(nowSeconds).toString(16)).slice(-8);
  const unique = crypto
    .createHash("sha256")
    .update(requestId)
    .digest("hex")
    .slice(0, 24);
  return "1-" + start + "-" + unique;
}
