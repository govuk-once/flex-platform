import { describe, expect, it } from "vitest";

import { replaceConsole } from "./console.ts";
import type { LogEntry, LogLevel } from "./log-writer.ts";

const SECRET = "SYNTHETIC_SECRET";

describe("replaceConsole", () => {
  it.each([
    "log",
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "dir",
    "table",
  ] as const)(
    "drops what console.%s is given, and logs where it was called from",
    (method) => {
      const written: { level: LogLevel; message: string; fields: LogEntry }[] =
        [];

      // A console of its own, so the test runner's is left alone.
      const target = Object.create(console) as Console;

      replaceConsole(
        {
          write: (level, message, fields) =>
            written.push({ level, message, fields }),
        },
        target,
      );

      target[method](SECRET, { secret: SECRET });

      expect(written).toEqual([
        {
          level: "warn",
          message: "console output dropped",
          fields: {
            method,
            frames: expect.arrayContaining([
              expect.stringContaining("console.test.ts"),
            ]) as string[],
          },
        },
      ]);
      expect(JSON.stringify(written)).not.toContain(SECRET);
    },
  );
});
