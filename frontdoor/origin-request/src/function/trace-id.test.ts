import { describe, expect, it } from "vitest";

import { NOW, REQUEST_ID, TRACE_ID } from "../../test/helpers.ts";
import { requestTraceId } from "./trace-id.ts";

describe("requestTraceId", () => {
  it("keeps the CloudFront Function's trace ID for this request", () => {
    expect(requestTraceId(TRACE_ID, REQUEST_ID, NOW + 5)).toBe(TRACE_ID);
  });

  it("derives the CloudFront Function's trace ID when none was forwarded", () => {
    expect(requestTraceId(undefined, REQUEST_ID, NOW + 0.75)).toBe(TRACE_ID);
  });

  it.each([
    ["another request's", "1-6b49d200-000000000000000000000000"],
    ["a malformed", `${TRACE_ID} `],
    ["an uppercase", TRACE_ID.toUpperCase()],
    ["an empty", ""],
  ])("replaces %s trace ID", (_, correlationId) => {
    expect(requestTraceId(correlationId, REQUEST_ID, NOW)).toBe(TRACE_ID);
  });
});
