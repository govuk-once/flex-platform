// What a route's `log` picks from a request's validated input or its response body, as a
// gateway's runtime picks its payload fields: scalar leaves only, so a field nested later is not
// logged unless it is named. Every path was checked against the schemas as the domain loaded.

import { isScalar } from "@repo/utils/is-scalar";
import { ownValue } from "@repo/utils/own-value";

export interface CompiledPath {
  readonly raw: string;
  readonly segments: readonly string[];
  readonly wildcard: boolean;
}

export function compilePaths(paths: readonly string[] = []): CompiledPath[] {
  return paths.map((raw) => {
    const segments = raw.split(".");

    return { raw, segments, wildcard: segments.includes("*") };
  });
}

// Null is a leaf a reader takes as one. A number JSON cannot write is not: `NaN` and the
// infinities reach a log as null, which reads as a field that was null rather than one not logged.
function isLoggable(value: unknown): boolean {
  return value === null || isScalar(value);
}

function children(node: object): unknown[] {
  return Array.isArray(node)
    ? [...(node as unknown[])]
    : Object.values(node as Record<string, unknown>);
}

// Every value the path matches; a `*` fans out over a list's entries and an object's values.
function resolvePath(data: unknown, segments: readonly string[]): unknown[] {
  let frontier: unknown[] = [data];

  for (const segment of segments) {
    frontier = frontier.flatMap((node) => {
      if (node === null || typeof node !== "object") return [];

      if (segment === "*") return children(node);

      const value = ownValue(node as Record<string, unknown>, segment);

      return value === undefined ? [] : [value];
    });
  }

  return frontier;
}

/** The picked values by path; a path with `*` gives a list. Empty when nothing matched. */
export function pickFields(
  data: unknown,
  paths: readonly CompiledPath[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};

  for (const { raw, segments, wildcard } of paths) {
    const matches = resolvePath(data, segments).filter(isLoggable);

    if (matches.length > 0) picked[raw] = wildcard ? matches : matches[0];
  }

  return picked;
}
