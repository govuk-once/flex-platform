import { AsyncLocalStorage } from "node:async_hooks";

import type { DestinationStream, Logger } from "pino";
import pino from "pino";

export type LogLevel = "info" | "warn" | "error";

export type LineFields = Readonly<Record<string, unknown>>;

export const REDACTED = "[redacted]";

const REQUEST_FIELDS: ReadonlySet<string> = new Set(["traceId", "route"]);

// The caller's token and IDs, while a handler runs and in anything it starts.
const callerValues = new AsyncLocalStorage<readonly string[]>();

/** Runs `run` with `values` replaced in every line written while it, or what it starts, runs. */
export function withCallerValues<Value>(
  values: readonly string[],
  run: () => Value,
): Value {
  // An empty value is in every text, and would redact the whole line.
  return callerValues.run(
    values.filter((value) => value !== ""),
    run,
  );
}

function redacted(value: unknown, held: readonly string[]): unknown {
  if (typeof value === "string") {
    return held.some((text) => value.includes(text)) ? REDACTED : value;
  }

  if (Array.isArray(value)) {
    return value.map((item: unknown) => redacted(item, held));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redacted(key, held),
        redacted(item, held),
      ]),
    );
  }

  return value;
}

// Redacts the finished line, since a handler can put a value in its message, its fields, or the
// bindings of a child it creates, and only the line holds all three. A line is parsed only when
// one of the values, as written or as JSON escapes it, appears in its text, and is then redacted
// field by field, so a value found inside a number or a key name cannot break the line. A line that
// does not parse has each value replaced as text.
function redactLine(line: string): string {
  const held = callerValues.getStore();

  if (held === undefined) return line;

  const found = held.filter(
    (value) =>
      line.includes(value) || line.includes(JSON.stringify(value).slice(1, -1)),
  );

  if (found.length === 0) return line;

  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return found.reduce(
      (text, value) => text.replaceAll(value, REDACTED),
      line,
    );
  }

  return `${JSON.stringify(redacted(parsed, found))}\n`;
}

/**
 * Writes lines under the domain's name, to standard output unless given a destination. A line
 * written within withCallerValues has those values replaced.
 */
export function createLogger(
  domainName: string,
  destination?: DestinationStream,
): Logger {
  return pino(
    { name: domainName, hooks: { streamWrite: redactLine } },
    destination,
  );
}

/** The request's own fields on every line: those it has of its trace ID and route. */
export function requestFields(
  traceId: string | undefined,
  routeKey: string | undefined,
): LineFields {
  return Object.fromEntries(
    Object.entries({ traceId, route: routeKey }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

function withoutRequestFields(fields: object): LineFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([key]) => !REQUEST_FIELDS.has(key)),
  );
}

// The request's fields are written by a formatter rather than bound, so what a handler writes
// under either name, in a line's fields or with `setBindings`, is dropped. A child the handler
// binds either name on writes it, and the request's after it. A child given its own `log`
// formatter replaces this one.
/** A handler's `log`: a child of `logger` whose every line holds the request's `fields`. */
export function createRequestLogger(
  logger: Logger,
  fields: LineFields,
): Logger {
  return logger.child(
    {},
    {
      formatters: {
        bindings: withoutRequestFields,
        log: (line) => ({ ...withoutRequestFields(line), ...fields }),
      },
    },
  );
}
