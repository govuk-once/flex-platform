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

// Every value the path matches; a `*` fans out over array entries and object values.
export function resolvePath(
  data: unknown,
  segments: readonly string[],
): unknown[] {
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

// The single value at an exact path, or undefined if a segment is absent or dead-ends on a
// non-object. No wildcard handling — use resolvePath for that.
export function valueAt(data: unknown, segments: readonly string[]): unknown {
  let node: unknown = data;

  for (const segment of segments) {
    if (node === null || typeof node !== "object") return undefined;
    if (!Object.hasOwn(node, segment)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }

  return node;
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
