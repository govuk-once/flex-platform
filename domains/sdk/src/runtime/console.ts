// In a deployed function, nothing written to `console` reaches the log: a call writes one line
// saying output was dropped, with the method and where it was called from, never what it was
// given. A domain's code and the libraries it uses can pass a request, a response or an error to
// `console`, and any of them can carry a caller's data. The SDK's own writer goes to standard
// output directly, so it is unaffected.

import { describeUnexpectedError } from "@repo/utils/describe-unexpected-error";

import type { LogSink } from "./log-writer.ts";

const METHODS = [
  "assert",
  "debug",
  "dir",
  "dirxml",
  "error",
  "info",
  "log",
  "table",
  "trace",
  "warn",
] as const;

/** Replaces `console`'s output methods with ones that log where they were called from. */
export function replaceConsole(sink: LogSink, target: Console = console): void {
  for (const method of METHODS) {
    target[method] = () => {
      const { frames } = describeUnexpectedError(new Error("console call"));

      sink.write("warn", "console output dropped", { method, frames });
    };
  }
}
