import { traceIdFor } from "@repo/cloudfront-js-utils/trace-id-for";
import { isTraceId } from "@repo/utils/is-trace-id";

// The trace ID the CloudFront Function set on this request, as `x-correlation-id`, so every log
// line for the request carries the same one. Its last 24 digits come from the request ID alone,
// so it is accepted only if they match this request's. Anything else is replaced, as the function
// would, from the request ID and the time now.
export function requestTraceId(
  correlationId: string | undefined,
  requestId: string,
  nowSeconds: number,
): string {
  const derived = traceIdFor(requestId, nowSeconds);
  if (
    correlationId !== undefined &&
    isTraceId(correlationId) &&
    correlationId.slice(11) === derived.slice(11)
  ) {
    return correlationId;
  }
  return derived;
}
