// Local only, never committed: the SDK's own writer, which writes the line Pino writes by default
// without depending on Pino. To use it, pass it as the `sink` where the SDK builds one.

import { hostname } from "node:os";

import type { LogLevel, LogSink } from "../../src/runtime/log-writer.ts";

const LEVEL_NUMBERS: Readonly<Record<LogLevel, number>> = {
  info: 30,
  warn: 40,
  error: 50,
};

export interface JsonLineOptions {
  readonly write?: (line: string) => void;
  readonly now?: () => number;
}

/** Writes each line as Pino does by default, with `name` the domain's. */
export function jsonLineSink(
  name: string,
  {
    write = (line) => process.stdout.write(line),
    now = Date.now,
  }: JsonLineOptions = {},
): LogSink {
  const host = hostname();

  return {
    write(level, message, fields) {
      write(
        `${JSON.stringify({
          level: LEVEL_NUMBERS[level],
          time: now(),
          pid: process.pid,
          hostname: host,
          name,
          ...fields,
          msg: message,
        })}\n`,
      );
    },
  };
}
