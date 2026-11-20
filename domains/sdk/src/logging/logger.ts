// The SDK's logger: pino, written synchronously to stdout, since an asynchronous destination can
// lose lines when a Lambda is frozen. Every object logged goes through the redactor, and so does
// every message and every field a child logger carries. An error is reduced to where it was
// created, because pino's own serialiser would write its message and stack, and either can hold
// a payload. Whatever else is logged under `err` or `error` is reduced the same way.

import type { DestinationStream, Logger as PinoLogger } from "pino";
import pino from "pino";

import type { RedactionOptions, Redactor } from "./redact.ts";
import { createRedactor } from "./redact.ts";
import { summarise } from "./summarise.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggingOptions extends RedactionOptions {
  /** The least level written. `info` unless set. */
  readonly level?: LogLevel;
}

export type LogFields = Readonly<Record<string, unknown>>;

/** What a handler logs with. Each method takes a fixed message and, optionally, fields. */
export interface Log {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** The SDK's own view of a logger: a Log that can open a child carrying more fields. */
export interface Logger extends Log {
  child(fields: LogFields): Logger;
}

function wrap(logger: PinoLogger, redactor: Redactor): Logger {
  const write =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      if (fields === undefined) {
        logger[level](message);
      } else {
        logger[level](fields, message);
      }
    };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    // Pino writes a child's fields as bindings, which never reach `formatters.log`, so they are
    // redacted here, before pino holds them.
    child: (fields) =>
      wrap(logger.child(redactor.redact(fields) as LogFields), redactor),
  };
}

/**
 * A logger named for the domain. `destination` is for tests, which read what was written; a
 * function's logger writes to stdout.
 */
export function createLogger(
  name: string,
  options: LoggingOptions = {},
  destination: DestinationStream = pino.destination({ fd: 1, sync: true }),
): Logger {
  const redactor = createRedactor(options);
  const logger = pino(
    {
      name,
      level: options.level ?? "info",
      // Pino writes `pid` and `hostname` unless told not to; neither says anything in a Lambda.
      base: {},
      // These run after `formatters.log`, where the redactor has already reduced a real error.
      serializers: { err: summarise, error: summarise },
      formatters: {
        // The level as its name, which is what a log query filters on.
        level: (label) => ({ level: label }),
        log: (fields) => redactor.redact(fields) as Record<string, unknown>,
      },
      hooks: {
        logMethod(args, method) {
          const redacted = args.map((argument) =>
            typeof argument === "string"
              ? redactor.redactString(argument)
              : argument,
          ) as typeof args;
          method.apply(this, redacted);
        },
      },
    },
    destination,
  );
  return wrap(logger, redactor);
}
