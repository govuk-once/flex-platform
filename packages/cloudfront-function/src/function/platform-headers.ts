import type { FieldValue } from "./event.ts";

// Headers only the platform sets. A caller's copy is removed before anything reads it.
const PLATFORM_HEADER_PREFIX = "x-flex-";

// Trace context a caller could send to pick the trace, or force every request to be sampled.
const CALLER_TRACE_HEADERS = ["traceparent", "tracestate", "x-amzn-trace-id"];

// Removes what a caller may not send: every `x-flex-` header, and any trace context. A function
// names in `callerHeaders` each `x-flex-` header it takes from a caller, such as one that holds a
// token, and checks that header itself. Named every time, even when there are none: esbuild can't
// rewrite a default argument for the runtime.
export function removePlatformHeaders(
  headers: Record<string, FieldValue>,
  callerHeaders: readonly string[],
): void {
  // forEach, not for...of, which the runtime lacks and esbuild can't rewrite for it.
  Object.keys(headers).forEach((name) => {
    if (callerHeaders.includes(name)) return;
    if (
      name.startsWith(PLATFORM_HEADER_PREFIX) ||
      CALLER_TRACE_HEADERS.includes(name)
    ) {
      delete headers[name];
    }
  });
}
