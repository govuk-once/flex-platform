const TRACE_ID = /^1-[0-9a-f]{8}-[0-9a-f]{24}$/;

/**
 * Whether text has an X-Ray trace ID's form, `1-<8 hex>-<24 hex>`, as `traceIdFor` makes one. A
 * value of this form holds no text of a caller's, so it can be logged as it is.
 */
export function isTraceId(value: string): boolean {
  return TRACE_ID.test(value);
}
