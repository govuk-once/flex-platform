import { afterEach, describe, expect, it, vi } from "vitest";

import { logTelemetry } from "./log-telemetry.ts";

describe("logTelemetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes one JSON line with the level, the event and its details", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logTelemetry("ERROR", "something_failed", { traceId: "trace" });

    expect(log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        level: "ERROR",
        message: "telemetry",
        telemetry: {
          event: "something_failed",
          details: { traceId: "trace" },
        },
      }),
    );
  });
});
