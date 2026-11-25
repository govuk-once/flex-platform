// What a route's input schemas may be, which checkDomain holds a configuration to as it loads.
//
// Every object in an input that names its fields refuses any other, as a gateway's inputs are held
// (design constraint 14): an input can be loosened later but never tightened. `z.object` drops
// what it does not name without a word, so a caller's mistake would go unseen. An object that
// names no field is an object of any shape, and stays open. So does each side of an intersection,
// since each closed would refuse the other's fields, though what its fields hold is checked.
//
// No input converts its value before checking it. `z.coerce` converts any value the way
// JavaScript does, which is loose: `Number("0x10")` is 16, `Number("")` is 0 and
// `Boolean("false")` is true. `z.stringbool()` takes "yes" and "off", and `z.preprocess` runs
// anything at all. A transform after a schema has checked the value is the domain's own, and is
// kept.
//
// A path or query parameter arrives as text, so its field must have a type that says how to read
// the text. The parameter reader asks the same question, so a configuration that loads is one the
// reader can read.

import {
  ZodArray,
  ZodCatch,
  ZodCodec,
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
  ZodTransform,
  ZodTuple,
  ZodType,
  ZodUnion,
} from "zod";

export const NOT_STRICT_PROBLEM =
  "accepts undeclared fields, must be a strict object";

export const CONVERTED_PROBLEM =
  "converts its input before validating it, must validate the input as sent";

export const UNREADABLE_PROBLEMS: Readonly<Record<ParameterLocation, string>> =
  {
    path: "invalid path parameter type, must be one of: string, number, boolean, enum",
    query:
      "invalid query parameter type, must be one of: string, number, boolean, enum, or an array of one",
  };

export const OPTIONAL_PATH_PROBLEM =
  "path parameter cannot be optional, it is always in the path";

export type ScalarType = "string" | "number" | "boolean";

export type ParameterLocation = "path" | "query";

export interface ParameterType {
  readonly scalar: ScalarType;
  // A query parameter declared as an array, read as every value it was sent with.
  readonly isArray: boolean;
}

export type ParameterTypesResult =
  | { readonly ok: true; readonly types: ReadonlyMap<string, ParameterType> }
  | { readonly ok: false; readonly problems: readonly string[] };

function isCoerced(schema: ZodType): boolean {
  const { def } = schema;

  return "coerce" in def && def.coerce === true;
}

// A schema that changes its input before checking it: coercion, a codec such as
// `z.stringbool()`, or `z.preprocess`, which is a pipe from a transform.
function convertsInput(schema: ZodType): boolean {
  return (
    isCoerced(schema) ||
    schema instanceof ZodCodec ||
    schema instanceof ZodTransform ||
    (schema instanceof ZodPipe && schema.def.in instanceof ZodTransform)
  );
}

/** Whether an object refuses every field it does not declare. */
export function isStrictObject(schema: ZodObject): boolean {
  return schema.def.catchall instanceof ZodNever;
}

// An object that declares no field is an object of any shape, so it need not be strict.
function mustBeStrict(schema: ZodObject): boolean {
  return Object.keys(schema.shape).length > 0 && !isStrictObject(schema);
}

// The schema whose input a wrapper takes as its own, or undefined for any other schema. A pipe
// that reaches here checks first, so its input is its first schema's.
function innerSchema(schema: unknown): unknown {
  if (schema instanceof ZodPipe) return schema.def.in;

  if (schema instanceof ZodLazy) return schema.def.getter();

  if (
    schema instanceof ZodOptional ||
    schema instanceof ZodNullable ||
    schema instanceof ZodDefault ||
    schema instanceof ZodPrefault ||
    schema instanceof ZodNonOptional ||
    schema instanceof ZodReadonly ||
    schema instanceof ZodCatch
  ) {
    return schema.def.innerType;
  }

  return undefined;
}

function fieldProblems(
  schema: ZodObject,
  at: string,
  seen: Set<unknown>,
): string[] {
  return [
    ...Object.entries(schema.shape).flatMap(([field, value]) =>
      strictInputProblems(value, `${at}.${field}`, seen),
    ),
    ...strictInputProblems(schema.def.catchall, `${at}[*]`, seen),
  ];
}

/**
 * A problem at each object in an input schema that names its fields but takes others too, and at
 * each schema that converts its input, with its location below `at`. A schema met again, as a
 * recursive one is, is not read twice.
 */
export function strictInputProblems(
  schema: unknown,
  at: string,
  seen = new Set<unknown>(),
): string[] {
  if (seen.has(schema)) return [];

  seen.add(schema);

  if (schema instanceof ZodType && convertsInput(schema)) {
    return [`${at}: ${CONVERTED_PROBLEM}`];
  }

  if (schema instanceof ZodObject) {
    return [
      ...(mustBeStrict(schema) ? [`${at}: ${NOT_STRICT_PROBLEM}`] : []),
      ...fieldProblems(schema, at, seen),
    ];
  }

  // Each side stays open, as closed it would refuse the other's fields. What each side's fields
  // hold is checked as any other input's.
  if (schema instanceof ZodIntersection) {
    return [schema.def.left, schema.def.right].flatMap((side) =>
      side instanceof ZodObject
        ? fieldProblems(side, at, seen)
        : strictInputProblems(side, at, seen),
    );
  }

  if (schema instanceof ZodArray) {
    return strictInputProblems(schema.def.element, `${at}[]`, seen);
  }

  if (schema instanceof ZodRecord) {
    return strictInputProblems(schema.def.valueType, `${at}[*]`, seen);
  }

  if (schema instanceof ZodTuple) {
    const { items, rest } = schema.def;

    return [
      ...items.flatMap((item, index) =>
        strictInputProblems(item, `${at}[${index}]`, seen),
      ),
      ...strictInputProblems(rest, `${at}[]`, seen),
    ];
  }

  if (schema instanceof ZodUnion) {
    return schema.def.options.flatMap((option) =>
      strictInputProblems(option, at, seen),
    );
  }

  const inner = innerSchema(schema);

  return inner === undefined ? [] : strictInputProblems(inner, at, seen);
}

// An enum's or a literal's values, when they are all of one type.
function scalarTypeOfValues(
  values: readonly unknown[],
): ScalarType | undefined {
  const types = new Set(values.map((value) => typeof value));

  const [type] = types;

  if (types.size !== 1) return undefined;

  return type === "string" || type === "number" || type === "boolean"
    ? type
    : undefined;
}

// Read from `def.type`, since a string format such as `z.uuid()` is not a `ZodString`.
function scalarTypeOf(schema: ZodType): ScalarType | undefined {
  if (schema instanceof ZodEnum) return scalarTypeOfValues(schema.options);

  if (schema instanceof ZodLiteral) {
    return scalarTypeOfValues(schema.def.values);
  }

  const { type } = schema.def;

  return type === "string" || type === "number" || type === "boolean"
    ? type
    : undefined;
}

// The schema a field takes when the parameter is sent.
function sentSchema(schema: unknown): unknown {
  return schema instanceof ZodOptional || schema instanceof ZodDefault
    ? sentSchema(schema.def.innerType)
    : schema;
}

type ParameterTypeResult =
  | { readonly ok: true; readonly type: ParameterType }
  | { readonly ok: false; readonly problem: string };

function parameterType(
  schema: unknown,
  location: ParameterLocation,
): ParameterTypeResult {
  const sent = sentSchema(schema);

  if (location === "path" && sent !== schema) {
    return { ok: false, problem: OPTIONAL_PATH_PROBLEM };
  }

  const isArray = location === "query" && sent instanceof ZodArray;

  const valueSchema = isArray ? sent.def.element : sent;

  if (!(valueSchema instanceof ZodType)) {
    return { ok: false, problem: UNREADABLE_PROBLEMS[location] };
  }

  if (convertsInput(valueSchema)) {
    return { ok: false, problem: CONVERTED_PROBLEM };
  }

  const scalar = scalarTypeOf(valueSchema);

  return scalar === undefined
    ? { ok: false, problem: UNREADABLE_PROBLEMS[location] }
    : { ok: true, type: { scalar, isArray } };
}

/**
 * The type each field of a route's `params` or `query` is read as, or a problem for each field
 * that cannot be read from text, as `<field>: <problem>`.
 */
export function parameterTypes(
  schema: ZodObject,
  location: ParameterLocation,
): ParameterTypesResult {
  // A Map, since the names a request sends are the caller's.
  const types = new Map<string, ParameterType>();

  const problems: string[] = [];

  for (const [name, field] of Object.entries(schema.shape)) {
    const result = parameterType(field, location);

    if (result.ok) {
      types.set(name, result.type);
    } else {
      problems.push(`${name}: ${result.problem}`);
    }
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, types };
}
