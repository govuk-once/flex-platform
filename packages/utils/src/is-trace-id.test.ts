import { describe, expect, it } from "vitest";

import { isTraceId } from "./is-trace-id.ts";

describe("isTraceId", () => {
  it("takes a trace ID", () => {
    expect(isTraceId("1-6b49d200-97575440147627ab6e7b6276")).toBe(true);
  });

  it.each([
    ["another version", "2-6b49d200-97575440147627ab6e7b6276"],
    ["uppercase", "1-6B49D200-97575440147627AB6E7B6276"],
    ["a short part", "1-6b49d20-97575440147627ab6e7b6276"],
    ["text around it", "x1-6b49d200-97575440147627ab6e7b6276"],
  ])("refuses %s", (_, value) => {
    expect(isTraceId(value)).toBe(false);
  });
});
