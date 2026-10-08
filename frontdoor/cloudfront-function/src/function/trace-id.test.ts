import { describe, expect, it } from "vitest";

import { NOW, REQUEST_ID } from "../../test/helpers.ts";
import { traceIdFor } from "./trace-id.ts";

describe("traceIdFor", () => {
  it("is an X-Ray trace ID starting at the request's time", () => {
    const traceId = traceIdFor(REQUEST_ID, NOW + 0.75);

    expect(traceId).toMatch(/^1-[0-9a-f]{8}-[0-9a-f]{24}$/);
    expect(traceId.slice(2, 10)).toBe(NOW.toString(16));
  });

  it("pads an early start to eight digits", () => {
    expect(traceIdFor(REQUEST_ID, 255).slice(0, 11)).toBe("1-000000ff-");
  });

  it("is the same for the same request", () => {
    expect(traceIdFor(REQUEST_ID, NOW)).toBe(traceIdFor(REQUEST_ID, NOW));
  });

  it("differs between requests", () => {
    expect(traceIdFor(REQUEST_ID, NOW).slice(11)).not.toBe(
      traceIdFor(`${REQUEST_ID}x`, NOW).slice(11),
    );
  });
});
