// Every object in an input that names its fields refuses any other, as a gateway's inputs are held
// (design constraint 14): an input can be loosened later but never tightened. `z.object` drops
// what it does not name without a word, so a caller's mistake would go unseen.
//
// An object that names no field is an object of any shape, and stays open. So does each side of an
// intersection, since each closed would refuse the other's fields. A schema of any other kind is
// taken as it is.

import {
  ZodArray,
  ZodCatch,
  ZodDefault,
  ZodLazy,
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
  ZodUnion,
} from "zod";

// The schema whose input a wrapper takes as its own, or undefined for any other schema.
function innerSchema(schema: unknown): unknown {
  // `z.preprocess` is a pipe from a function, which takes anything, into the schema that reads its
  // result, so that schema is the input's shape.
  if (schema instanceof ZodPipe) {
    const { in: first, out: second } = schema.def;

    return first instanceof ZodTransform ? second : first;
  }

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

/**
 * A problem at each object in an input schema that names its fields but takes others too, with
 * the object's location below `at`. A schema met again, as a recursive one is, is not read twice.
 */
export function strictInputProblems(
  schema: unknown,
  at: string,
  seen = new Set<unknown>(),
): string[] {
  if (seen.has(schema)) return [];

  seen.add(schema);

  if (schema instanceof ZodObject) {
    const fields = Object.entries(schema.shape);

    const { catchall } = schema.def;

    return [
      ...(fields.length > 0 && !(catchall instanceof ZodNever)
        ? [
            `${at}: accepts fields it does not name; declare it with z.strictObject or .strict()`,
          ]
        : []),
      ...fields.flatMap(([field, value]) =>
        strictInputProblems(value, `${at}.${field}`, seen),
      ),
      ...strictInputProblems(catchall, `${at}[*]`, seen),
    ];
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
