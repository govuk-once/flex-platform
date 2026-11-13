import { afterEach, describe, expect, it, vi } from "vitest";

import { logOutcome } from "./telemetry.ts";

const IDS = {
  traceId: "1-6b49d200-0123456789abcdef01234567",
  requestId: "r-1",
};

afterEach(() => {
  vi.restoreAllMocks();
});

function logged(log: () => void): unknown[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(line);
  });
  log();
  return lines.map((line) => JSON.parse(line) as unknown);
}

describe("logOutcome", () => {
  it("writes one line, with the event and both IDs", () => {
    expect(
      logged(() => {
        logOutcome("viewer_request_path_rejected", IDS);
      }),
    ).toEqual([
      {
        level: "INFO",
        message: "telemetry",
        telemetry: { event: "viewer_request_path_rejected", details: IDS },
      },
    ]);
  });

  it("adds a reason when there is one", () => {
    expect(
      logged(() => {
        logOutcome("viewer_request_token_invalid", IDS, "segments");
      }),
    ).toEqual([
      {
        level: "INFO",
        message: "telemetry",
        telemetry: {
          event: "viewer_request_token_invalid",
          details: { ...IDS, reason: "segments" },
        },
      },
    ]);
  });
});
