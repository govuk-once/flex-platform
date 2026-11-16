import { describe, expect, it } from "vitest";

import type { FieldValue } from "./event.ts";
import { removePlatformHeaders } from "./platform-headers.ts";

function headers(names: readonly string[]): Record<string, FieldValue> {
  const all: Record<string, FieldValue> = {};
  for (const name of names) all[name] = { value: "from the caller" };
  return all;
}

function remaining(
  names: readonly string[],
  callerHeaders: readonly string[] = [],
): string[] {
  const all = headers(names);
  removePlatformHeaders(all, callerHeaders);
  return Object.keys(all);
}

describe("removePlatformHeaders", () => {
  it("removes every x-flex- header a caller sends", () => {
    expect(
      remaining(["accept", "x-flex-secure", "x-flex-anything", "x-flexible"]),
    ).toEqual(["accept", "x-flexible"]);
  });

  // A caller who chose the trace could tie requests together, or force every one to be sampled.
  it("removes any trace context a caller sends", () => {
    expect(
      remaining(["traceparent", "tracestate", "x-amzn-trace-id", "user-agent"]),
    ).toEqual(["user-agent"]);
  });

  it("keeps an x-flex- header the function takes from a caller, and no other", () => {
    expect(
      remaining(
        ["x-flex-ci-token", "x-flex-ci-token-2", "x-flex-secure"],
        ["x-flex-ci-token"],
      ),
    ).toEqual(["x-flex-ci-token"]);
  });

  // Naming a header keeps only that header: trace context is removed whatever is named.
  it("still removes trace context when a header is kept", () => {
    expect(remaining(["traceparent"], ["x-flex-ci-token"])).toEqual([]);
  });

  it("leaves the header's value as the caller sent it", () => {
    const all: Record<string, FieldValue> = {
      "x-flex-ci-token": {
        value: "first",
        multiValue: [{ value: "first" }, { value: "second" }],
      },
    };

    removePlatformHeaders(all, ["x-flex-ci-token"]);

    expect(all).toEqual({
      "x-flex-ci-token": {
        value: "first",
        multiValue: [{ value: "first" }, { value: "second" }],
      },
    });
  });
});
