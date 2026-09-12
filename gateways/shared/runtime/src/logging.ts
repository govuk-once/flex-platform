import type { Logger } from "pino";
import pino from "pino";

import type { CompiledPath } from "./field-path.ts";
import { resolvePath } from "./field-path.ts";

export type { Logger } from "pino";

export function createLogger(gatewayId: string): Logger {
  return pino({ name: gatewayId });
}

// Log scalar leaves only so new nested fields require their own allowlist entries.
function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

// Always an object, empty when nothing matched, so a response log always carries the key.
export function pickFields(
  data: unknown,
  paths: readonly CompiledPath[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const path of paths) {
    const matches = resolvePath(data, path.segments).filter(isScalar);
    if (matches.length === 0) continue;
    result[path.raw] = path.wildcard ? matches : matches[0];
  }

  return result;
}
