import type {
  DriverContext,
  DriverLogFields,
  DriverLogger,
} from "@repo/gateway-types";
import { isScalar } from "@repo/utils/is-scalar";

import { GatewayError } from "./errors.ts";
import type { ResolvedPolicy } from "./policy.ts";

export interface DeadlineProvider {
  remainingMs(): number;
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
  });
}

// What a driver reported about one exchange, as it reported it. Nothing here is trusted: the
// handler decides what of it a caller and a log see.
export type ReportedMeta = Map<string, unknown>;

// Where a driver's lines go: a logger that already names the operation.
export interface DriverLogSink {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

const SILENT: DriverLogSink = { info: () => undefined, warn: () => undefined };

// Scalars only, whatever a JavaScript driver passes, and under a key of their own, so a field
// cannot stand in for the runtime's `operation` or `msg`.
function driverFields(fields: DriverLogFields | undefined): object {
  if (fields === undefined) return {};
  const kept = Object.fromEntries(
    Object.entries(fields).filter(
      ([, value]) => value === null || isScalar(value),
    ),
  );
  return Object.keys(kept).length === 0 ? {} : { driver: kept };
}

export function driverLogger(sink: DriverLogSink): DriverLogger {
  return {
    info: (message, fields) => {
      sink.info(driverFields(fields), message);
    },
    warn: (message, fields) => {
      sink.warn(driverFields(fields), message);
    },
  };
}

export function createDriverContext(
  policy: ResolvedPolicy,
  deadline: DeadlineProvider,
  reported: ReportedMeta = new Map(),
  log: DriverLogSink = SILENT,
): DriverContext {
  return {
    log: driverLogger(log),
    meta(name: string, value: unknown): void {
      reported.set(name, value);
    },

    async upstream<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const remaining = deadline.remainingMs();
      if (remaining <= 0) {
        throw new GatewayError(
          "UPSTREAM_TIMEOUT",
          "Deadline exhausted before the upstream call",
        );
      }

      const budget = Math.min(policy.timeoutMs, remaining);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budget);
      const { signal } = controller;

      try {
        const result = await Promise.race([fn(signal), rejectOnAbort(signal)]);
        clearTimeout(timer);
        return result;
      } catch (err: unknown) {
        clearTimeout(timer);
        if (signal.aborted) {
          throw new GatewayError("UPSTREAM_TIMEOUT", "Upstream call timed out");
        }
        throw err;
      }
    },
  };
}
