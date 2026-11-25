// Where the SDK's lines and a handler's own go: Pino, writing one JSON object a line on standard
// output, which Lambda writes to the function's log group. The gateways log through Pino too, so
// one query reads both. A test or a local server passes its own destination.
//
// The caller token and the caller's IDs are never logged. The SDK holds a request's own values,
// and replaces any logged text that holds one, wherever it came from, then says where on the line.
// Only those exact values are looked for: there is no redaction by pattern.

import { isScalar } from "@repo/utils/is-scalar";
import pino from "pino";

import type { Log, LogFields } from "../log.ts";

export type LogLevel = "info" | "warn" | "error";

export type LogEntry = Readonly<Record<string, unknown>>;

export interface LogSink {
  write(level: LogLevel, message: string, fields: LogEntry): void;
}

/** Where a line is written, as text ending in a newline. */
export interface LogDestination {
  write(line: string): void;
}

/** Writes each line through Pino, with `name` the domain's, to standard output by default. */
export function pinoSink(name: string, destination?: LogDestination): LogSink {
  const logger =
    destination === undefined ? pino({ name }) : pino({ name }, destination);

  return {
    write(level, message, fields) {
      logger[level](fields, message);
    },
  };
}

export const CALLER_VALUE_REPLACEMENT = "[caller value]";

/** Replaces the caller's token and IDs wherever they appear in what a line would log. */
export function callerValueGuard(values: readonly string[]) {
  const held = values.filter((value) => value !== "");

  function guarded(value: unknown, at: string, replaced: string[]): unknown {
    if (typeof value === "string") {
      if (!held.some((secret) => value.includes(secret))) return value;

      replaced.push(at);

      return CALLER_VALUE_REPLACEMENT;
    }

    if (Array.isArray(value)) {
      return value.map((item: unknown, index) =>
        guarded(item, `${at}[${index}]`, replaced),
      );
    }

    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          guarded(item, at === "" ? key : `${at}.${key}`, replaced),
        ]),
      );
    }

    return value;
  }

  return (fields: LogEntry): { fields: LogEntry; replaced: string[] } => {
    const replaced: string[] = [];

    return {
      fields: guarded(fields, "", replaced) as LogEntry,
      replaced,
    };
  };
}

export type CallerValueGuard = ReturnType<typeof callerValueGuard>;

// Scalars only, whatever JavaScript passes, and under a key of their own, so a field cannot stand
// in for `msg` or `traceId`.
function handlerFields(fields: LogFields | undefined): LogEntry {
  if (fields === undefined) return {};

  const kept = Object.entries(fields).filter(
    ([, value]) => value === null || isScalar(value),
  );

  return kept.length === 0 ? {} : { fields: Object.fromEntries(kept) };
}

/** A handler's `log`, with the request's trace ID and route on every line. */
export function handlerLog(
  sink: LogSink,
  context: LogEntry,
  guard: CallerValueGuard,
): Log {
  const write = (level: LogLevel, message: string, fields?: LogFields) => {
    const { fields: safe, replaced } = guard(handlerFields(fields));

    // The message is fixed text by type; one that holds a caller value anyway is not written.
    const { replaced: inMessage } = guard({ msg: message });

    const text = inMessage.length > 0 ? CALLER_VALUE_REPLACEMENT : message;

    const all = [...inMessage, ...replaced];

    sink.write(all.length > 0 ? "warn" : level, text, {
      ...context,
      ...safe,
      ...(all.length > 0 ? { replaced: all } : {}),
    });
  };

  return {
    info: (message: string, fields?: LogFields) => {
      write("info", message, fields);
    },
    warn: (message: string, fields?: LogFields) => {
      write("warn", message, fields);
    },
  };
}
