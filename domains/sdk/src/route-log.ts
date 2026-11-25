// Checks a route's `log` field. It may name only: scalar fields its schemas declare, so a path that names an
// object, a list or nothing at all is refused as the domain loads, not found missing from a log
// after an incident. A gateway's configuration is reviewed in this repository and its paths are
// not checked; a domain's is reviewed in its own, so the SDK checks them.
//
// A path is read against what a schema produces, as the values it picks are the validated ones.

import { isRecord } from "@repo/utils/is-record";
import {
  ZodArray,
  ZodCatch,
  ZodDefault,
  ZodEnum,
  ZodIntersection,
  ZodLazy,
  ZodLiteral,
  ZodNever,
  ZodNonOptional,
  ZodNullable,
  ZodObject,
  ZodOptional,
  ZodPipe,
  ZodPrefault,
  ZodReadonly,
  ZodRecord,
  ZodTuple,
  ZodType,
  ZodUnion,
} from "zod";

const INPUT_PARTS: ReadonlySet<string> = new Set(["params", "query", "body"]);

const SCALAR_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "null",
]);

const WILDCARD = "*";

// Shown in a problem, as paths each list may hold.
const INPUT_EXAMPLES = ["params.id", "body.items.*.status"] as const;

const OUTPUT_EXAMPLES = ["id", "items.*.status"] as const;

// The schema a wrapper produces its output from, or the schema itself.
function outputSchema(schema: unknown, seen = new Set<unknown>()): unknown {
  if (seen.has(schema)) return schema;

  seen.add(schema);

  if (schema instanceof ZodPipe) return outputSchema(schema.def.out, seen);

  if (schema instanceof ZodLazy) return outputSchema(schema.def.getter(), seen);

  if (
    schema instanceof ZodOptional ||
    schema instanceof ZodNullable ||
    schema instanceof ZodDefault ||
    schema instanceof ZodPrefault ||
    schema instanceof ZodNonOptional ||
    schema instanceof ZodReadonly ||
    schema instanceof ZodCatch
  ) {
    return outputSchema(schema.def.innerType, seen);
  }

  return schema;
}

function isScalarSchema(schema: unknown): boolean {
  if (!(schema instanceof ZodType)) return false;

  if (schema instanceof ZodEnum) return true;

  if (schema instanceof ZodUnion) {
    return schema.def.options.every((option) =>
      isScalarSchema(outputSchema(option)),
    );
  }

  if (schema instanceof ZodLiteral) {
    return schema.def.values.every(
      (value) =>
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean",
    );
  }

  return SCALAR_TYPES.has(schema.def.type);
}

function shapeField(schema: ZodObject, segment: string): unknown {
  const { shape } = schema;

  if (Object.hasOwn(shape, segment)) return shape[segment];

  const { catchall } = schema.def;

  return catchall instanceof ZodNever ? undefined : catchall;
}

// The schemas one segment leads to from `schema`, empty when it leads nowhere.
function schemasAt(schema: unknown, segment: string): unknown[] {
  if (schema instanceof ZodUnion) {
    return schema.def.options.flatMap((option) =>
      schemasAt(outputSchema(option), segment),
    );
  }

  if (schema instanceof ZodIntersection) {
    const { left, right } = schema.def;

    return [
      ...schemasAt(outputSchema(left), segment),
      ...schemasAt(outputSchema(right), segment),
    ];
  }

  if (schema instanceof ZodObject) {
    if (segment === WILDCARD) return Object.values(schema.shape);

    const field = shapeField(schema, segment);

    return field === undefined ? [] : [field];
  }

  if (schema instanceof ZodRecord) return [schema.def.valueType];

  if (segment !== WILDCARD) return [];

  if (schema instanceof ZodArray) return [schema.def.element];

  if (schema instanceof ZodTuple) {
    const { items, rest } = schema.def;

    return rest === null ? [...items] : [...items, rest];
  }

  return [];
}

// Whether every schema the path leads to from `schema` is a scalar, and it leads somewhere.
function namesScalarField(
  schema: unknown,
  segments: readonly string[],
): boolean {
  let reached = [outputSchema(schema)];

  for (const segment of segments) {
    reached = reached.flatMap((current) =>
      schemasAt(current, segment).map((next) => outputSchema(next)),
    );

    if (reached.length === 0) return false;
  }

  return reached.every(isScalarSchema);
}

function segmentsOf(path: unknown): readonly string[] | undefined {
  if (typeof path !== "string" || path === "") return undefined;

  const segments = path.split(".");

  return segments.includes("") ? undefined : segments;
}

function pathListProblems(
  paths: unknown,
  at: string,
  check: (segments: readonly string[]) => boolean,
  rule: string,
  [first, second]: readonly [string, string],
): string[] {
  if (paths === undefined) return [];

  if (!Array.isArray(paths)) {
    return [
      `${at}: invalid type, must be an array of dot paths, such as ["${first}", "${second}"]`,
    ];
  }

  return paths.flatMap((path: unknown, index) => {
    const segments = segmentsOf(path);

    if (segments === undefined) {
      return [
        `${at}[${index}]: invalid path, must be a dot path, such as "${first}" or "${second}"`,
      ];
    }

    return check(segments)
      ? []
      : [
          `${at}[${index}]: ${JSON.stringify(path)} not a scalar field, ${rule}`,
        ];
  });
}

export interface RouteLogSchemas {
  readonly params?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
  readonly responses: readonly unknown[];
}

/**
 * A problem for each path in a route's `log` that does not name a scalar field its schemas
 * declare. `input` paths start at `params`, `query` or `body`; `output` paths at a response body,
 * and name a field in at least one response.
 */
export function routeLogProblems(
  log: unknown,
  schemas: RouteLogSchemas,
  at: string,
): string[] {
  if (log === undefined) return [];

  if (!isRecord(log)) {
    return [
      `${at}: invalid type, must be an object with input, output or both`,
    ];
  }

  const { input, output, ...rest } = log;

  const parts: ReadonlyMap<string, unknown> = new Map(Object.entries(schemas));

  return [
    ...Object.keys(rest).map(
      (field) => `${at}.${field}: unknown field, must be one of: input, output`,
    ),
    ...pathListProblems(
      input,
      `${at}.input`,
      ([part = "", ...segments]) => {
        const schema = INPUT_PARTS.has(part) ? parts.get(part) : undefined;

        return schema instanceof ZodType && namesScalarField(schema, segments);
      },
      "must name one in params, query or body",
      INPUT_EXAMPLES,
    ),
    ...pathListProblems(
      output,
      `${at}.output`,
      (segments) =>
        schemas.responses.some(
          (schema) =>
            schema instanceof ZodType && namesScalarField(schema, segments),
        ),
      "must name one in a declared response",
      OUTPUT_EXAMPLES,
    ),
  ];
}
