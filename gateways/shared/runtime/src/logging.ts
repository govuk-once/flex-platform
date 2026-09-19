import { isScalar } from "@repo/utils/is-scalar";
import type { Logger } from "pino";
import pino from "pino";

import type { CompiledPath } from "./field-path.ts";
import { resolvePath } from "./field-path.ts";

export type { Logger } from "pino";

export function createLogger(gatewayId: string): Logger {
  return pino({ name: gatewayId });
}

// Log scalar leaves only, so a newly nested field needs its own allowlist entry. Null is a leaf
// a caller can read as one, where a number JSON cannot write is not: `NaN` and the infinities
// reach a log as null, which reads as a field that was null rather than one that was not logged.
function isLoggable(value: unknown): boolean {
  return value === null || isScalar(value);
}

// Always an object, empty when nothing matched, so a response log always carries the key.
export function pickFields(
  data: unknown,
  paths: readonly CompiledPath[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const path of paths) {
    const matches = resolvePath(data, path.segments).filter(isLoggable);
    if (matches.length === 0) continue;
    result[path.raw] = path.wildcard ? matches : matches[0];
  }

  return result;
}
