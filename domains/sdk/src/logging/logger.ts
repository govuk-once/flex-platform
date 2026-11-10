// The SDK's logger: pino, written synchronously to stdout, since an asynchronous destination can
// lose lines when a Lambda is frozen. Every object logged goes through the redactor, and so does
// every message. An error logged under `err` or `error` is reduced to where it was created,
// because pino's own serialiser would write its message and stack, and either can hold a payload.

import type { UnexpectedErrorSummary } from "@repo/utils/describe-unexpected-error";
import { describeUnexpectedError } from "@repo/utils/describe-unexpected-error";
import type { DestinationStream, Logger as PinoLogger } from "pino";
import pino from "pino";

import type { RedactionOptions } from "./redact.ts";
import { createRedactor } from "./redact.ts";

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

function summarise(error: unknown): UnexpectedErrorSummary {
  return describeUnexpectedError(error);
}

function wrap(logger: PinoLogger): Logger {
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
    child: (fields) => wrap(logger.child(fields)),
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
  return wrap(logger);
}
