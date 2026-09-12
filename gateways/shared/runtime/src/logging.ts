import type { Logger } from "pino";
import pino from "pino";

import type { CompiledPath } from "./field-path.ts";
import { resolvePath } from "./field-path.ts";

export type { Logger } from "pino";

export function createLogger(gatewayId: string): Logger {
  return pino({ name: gatewayId });
}

export function pickFields(
  data: unknown,
  paths: readonly CompiledPath[],
): Record<string, unknown> | undefined {
  let result: Record<string, unknown> | undefined;

  for (const path of paths) {
    const matches = resolvePath(data, path.segments);
    if (matches.length === 0) continue;
    result ??= {};
    result[path.raw] = path.wildcard ? matches : matches[0];
  }

  return result;
}
