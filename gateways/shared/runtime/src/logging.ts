import type { Logger } from "pino";
import pino from "pino";

export type { Logger } from "pino";

export function createLogger(gatewayId: string): Logger {
  return pino({ name: gatewayId });
}

export interface CompiledPath {
  readonly raw: string;
  readonly segments: readonly string[];
  readonly wildcard: boolean;
}

export function compilePaths(paths: readonly string[]): CompiledPath[] {
  return paths.map((raw) => {
    const segments = raw.split(".");
    if (raw.length === 0 || segments.some((s) => s.length === 0)) {
      throw new TypeError(`Invalid field path: ${JSON.stringify(raw)}`);
    }
    return { raw, segments, wildcard: segments.includes("*") };
  });
}

export function pickFields(
  data: unknown,
  paths: readonly CompiledPath[],
): Record<string, unknown> | undefined {
  let result: Record<string, unknown> | undefined;

  for (const path of paths) {
    const matches = resolve(data, path.segments);
    if (matches.length === 0) continue;
    result ??= {};
    result[path.raw] = path.wildcard ? matches : matches[0];
  }

  return result;
}

function resolve(data: unknown, segments: readonly string[]): unknown[] {
  let frontier: unknown[] = [data];

  for (const segment of segments) {
    const next: unknown[] = [];

    for (const node of frontier) {
      if (node === null || typeof node !== "object") continue;

      if (segment === "*") {
        expandWildcard(node, next);
      } else if (Object.hasOwn(node, segment)) {
        pushDefined(next, (node as Record<string, unknown>)[segment]);
      }
    }

    if (next.length === 0) return next; // nothing left to descend into
    frontier = next;
  }

  return frontier;
}

function expandWildcard(node: object, out: unknown[]): void {
  if (Array.isArray(node)) {
    for (const value of node) {
      pushDefined(out, value);
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const key in obj) {
    if (Object.hasOwn(obj, key)) {
      pushDefined(out, obj[key]);
    }
  }
}

function pushDefined(out: unknown[], value: unknown): void {
  if (value !== undefined) {
    out.push(value);
  }
}
