import { describe, expect, it } from "vitest";

import type { CallSiteLocation } from "./frame-locations.ts";
import { selectFrameLocations } from "./frame-locations.ts";

describe("selectFrameLocations", () => {
  // The casts let a test hand the selector what V8 never should, to show it is checked anyway.
  function site(
    filename: unknown,
    line: unknown = 1,
    column: unknown = 1,
    isEval = false,
  ): CallSiteLocation {
    return {
      isEval: () => isEval,
      getFileName: () => filename as string | null,
      getLineNumber: () => line as number | null,
      getColumnNumber: () => column as number | null,
    };
  }

  it("accepts paths, local file URLs and node internals, spaces and parentheses included", () => {
    expect(
      selectFrameLocations([
        site("/srv/my app/(gateway)/handler.js", 42, 7),
        site("file:///srv/my%20app/(gateway)/index.js", 3, 1),
        site("C:\\srv\\gateway\\handler.js", 1, 2),
        site("node:internal/process/task_queues", 105, 5),
      ]),
    ).toEqual([
      "at /srv/my app/(gateway)/handler.js:42:7",
      "at file:///srv/my%20app/(gateway)/index.js:3:1",
      "at C:\\srv\\gateway\\handler.js:1:2",
      "at node:internal/process/task_queues:105:5",
    ]);
  });

  it("rejects eval frames, unsupported locations and invalid coordinates", () => {
    expect(
      selectFrameLocations([
        site("/srv/gateway/handler.js", 1, 1, true),
        site(null),
        site(undefined),
        site(""),
        site("<anonymous>"),
        site("https://example.test/handler.js?token=SYNTHETIC"),
        site("data:text/javascript,SYNTHETIC"),
        site("file://host/srv/handler.js"),
        site("file://["),
        site("file:///srv/handler.js?v=SYNTHETIC"),
        site("file:///srv/handler.js#SYNTHETIC"),
        site("/srv/handler.js", 0, 1),
        site("/srv/handler.js", 1, -1),
        site("/srv/handler.js", 1.5, 1),
        site("/srv/handler.js", Number.NaN, 1),
        site("/srv/handler.js", 1, 2 ** 53),
        site("/srv/handler.js", "1", 1),
        site("/srv/handler.js", null, 1),
      ]),
    ).toEqual([]);
  });

  it("respects the limits", () => {
    const valid = (i: number) => site(`/srv/gateway/f${i}.js`, i + 1, 1);
    const twenty = Array.from({ length: 20 }, (_, i) => valid(i));
    expect(selectFrameLocations(twenty)).toHaveLength(10);
    expect(selectFrameLocations(twenty)[9]).toBe("at /srv/gateway/f9.js:10:1");

    expect(selectFrameLocations([site(`/${"a".repeat(2000)}.js`)])).toEqual([]);

    const late = [...Array.from({ length: 50 }, () => site(null)), valid(0)];
    expect(selectFrameLocations(late)).toEqual([]);
  });
});
