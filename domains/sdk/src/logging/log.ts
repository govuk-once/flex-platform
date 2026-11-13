// A logger for code outside a handler's context, which writes to the request's logger while a
// request is being handled, and to the domain's logger otherwise, so a line written as a module
// loads has the domain's name, level and redaction. Before any domain is declared, it writes to
// a plain logger named for the SDK.

import { requestStorage } from "../context.ts";
import type { Log, LogFields, Logger, LogLevel } from "./logger.ts";
import { createLogger } from "./logger.ts";

let fallback: Logger | undefined;

/** Makes a domain's logger the one `log` writes to outside a request. */
export function setFallbackLogger(logger: Logger): void {
  fallback = logger;
}

function current(): Log {
  const store = requestStorage.getStore();
  if (store !== undefined) return store.log;
  fallback ??= createLogger("flex-domain-sdk");
  return fallback;
}

const write =
  (level: LogLevel) =>
  (message: string, fields?: LogFields): void => {
    current()[level](message, fields);
  };

export const log: Log = {
  debug: write("debug"),
  info: write("info"),
  warn: write("warn"),
  error: write("error"),
};
