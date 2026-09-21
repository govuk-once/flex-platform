import { isDeepStrictEqual } from "node:util";

import { isRecord } from "@repo/utils/is-record";

import {
  setKey,
  SUBSCHEMA_LISTS,
  SUBSCHEMA_MAPS,
  SUBSCHEMAS,
} from "./convert.ts";

// What an operation states of a schema, set into what the upstream's document says of it. It can
// make a schema admit less and nothing else: every step here either replaces "an object of any
// shape", or any value at all, with what is stated, adds a constraint to an object the document
// left open to it, or, where neither is plainly the case, sets the two side by side as an
// `allOf`, which holds both whatever they say. The plain cases are worked through rather than left to `allOf`
// because of what is read afterwards: a reviewer reads the version, and the contract is
// generated from it, and one schema that says what a field is serves both better than two that
// have to be read together.

const ANNOTATIONS: ReadonlySet<string> = new Set([
  "$comment",
  "default",
  "deprecated",
  "description",
  "readOnly",
  "title",
  "writeOnly",
]);

type Schema = Readonly<Record<string, unknown>>;

const only = (schema: Schema, keys: readonly string[]): boolean =>
  Object.keys(schema).every(
    (key) => keys.includes(key) || ANNOTATIONS.has(key),
  );

const admitsAnything = (schema: unknown): boolean =>
  schema === undefined ||
  schema === true ||
  (isRecord(schema) && Object.keys(schema).length === 0);

// An object of any shape: what a store that keeps whatever it is given says of what it keeps.
function isBag(schema: unknown): schema is Schema {
  return (
    isRecord(schema) &&
    schema.type === "object" &&
    only(schema, ["type", "properties", "additionalProperties"]) &&
    (schema.properties === undefined ||
      (isRecord(schema.properties) &&
        Object.keys(schema.properties).length === 0)) &&
    admitsAnything(schema.additionalProperties)
  );
}

const OBJECT_KEYWORDS = [
  "type",
  "properties",
  "required",
  "additionalProperties",
];

const isPlainObject = (schema: unknown): schema is Schema =>
  isRecord(schema) && schema.type === "object" && only(schema, OBJECT_KEYWORDS);

const isPlainArray = (schema: unknown): schema is Schema =>
  isRecord(schema) &&
  schema.type === "array" &&
  only(schema, ["type", "items"]);

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

// A name an object literal reads as its prototype rather than as a property, which is what a
// version is refused for holding: read here as well, so what is wrong with a narrowing is said
// of the narrowing rather than of the schema it was set into.
const UNUSABLE_NAME = "__proto__";

// References, which a narrowing has nothing to point at: it is written on its own, in the
// configuration, with no document or definitions of its own around it.
const REFERENCES = ["$ref", "$dynamicRef"];

// Everything wrong with one schema of a narrowing, read before any of it is set into another:
// its shape, a name that cannot be one, and a reference, which has nothing to refer to. Where a
// schema goes is read the same way as everywhere else a schema is walked, so a reference inside
// a composition is found and a field named "$ref" or "properties" is the field it is.
export function narrowingProblems(
  schema: unknown,
  where: string,
  problems: string[],
): void {
  // `true` and `false` are schemas: one admits every value and the other none, which is how a
  // tuple says it ends and how an object refuses a field.
  if (typeof schema === "boolean") return;
  if (!isRecord(schema)) {
    problems.push(`${where} must be a schema object`);
    return;
  }
  for (const key of REFERENCES) {
    if (Object.hasOwn(schema, key)) {
      problems.push(
        `${where} must be written out; it has nothing a "${key}" could refer to`,
      );
    }
  }
  if (Object.hasOwn(schema, UNUSABLE_NAME)) {
    problems.push(`${where} cannot declare "${UNUSABLE_NAME}"`);
  }

  // A narrowing is merged into what the document says, so a keyword written as something other
  // than what it takes would be filtered out on the way and the schema would compile without
  // saying what it was written to say: `required: "id"` is not a list, and neither is
  // `properties: []` an object.
  if (Object.hasOwn(schema, "required")) {
    const listed: unknown = schema.required;
    if (
      !Array.isArray(listed) ||
      !listed.every((name) => typeof name === "string")
    ) {
      problems.push(`${where}.required must be a list of field names`);
    } else if (listed.includes(UNUSABLE_NAME)) {
      problems.push(`${where}.required cannot list "${UNUSABLE_NAME}"`);
    }
  }

  for (const key of SUBSCHEMA_MAPS) {
    if (!Object.hasOwn(schema, key)) continue;
    const held: unknown = schema[key];
    if (!isRecord(held)) {
      problems.push(`${where}.${key} must be an object of schemas`);
      continue;
    }
    for (const [name, member] of Object.entries(held)) {
      if (name === UNUSABLE_NAME) {
        problems.push(`${where}.${key} cannot declare "${UNUSABLE_NAME}"`);
        continue;
      }
      narrowingProblems(member, `${where}.${key}.${name}`, problems);
    }
  }

  for (const key of SUBSCHEMA_LISTS) {
    if (!Object.hasOwn(schema, key)) continue;
    const held: unknown = schema[key];
    if (!Array.isArray(held)) {
      problems.push(`${where}.${key} must be a list of schemas`);
      continue;
    }
    (held as readonly unknown[]).forEach((member, index) => {
      narrowingProblems(member, `${where}.${key}.${String(index)}`, problems);
    });
  }

  for (const key of SUBSCHEMAS) {
    if (!Object.hasOwn(schema, key)) continue;
    narrowingProblems(schema[key], `${where}.${key}`, problems);
  }
}

export function narrowInto(
  derived: unknown,
  narrowing: unknown,
  where: string,
  problems: string[],
): unknown {
  if (narrowing === undefined) return derived;
  // Anything at all, so whatever is stated in its place admits less.
  if (derived === true || (isRecord(derived) && admitsAnything(derived))) {
    return narrowing;
  }
  const beside = { allOf: [derived, narrowing] };

  // Any object at all, so an object stated in its place admits less — but only one that admits
  // objects and nothing else. A schema that also admits null, however it says so, admits what
  // the bag did not, and replacing the bag with it would widen what a caller may send.
  if (isBag(derived)) {
    if (
      !isRecord(narrowing) ||
      narrowing.type !== "object" ||
      narrowing.nullable === true
    ) {
      return beside;
    }
    return typeof derived.description === "string" &&
      narrowing.description === undefined
      ? { description: derived.description, ...narrowing }
      : narrowing;
  }

  if (isPlainArray(derived) && isPlainArray(narrowing)) {
    return withAnnotations(
      {
        ...derived,
        items: narrowInto(
          derived.items ?? {},
          narrowing.items,
          `${where}.items`,
          problems,
        ),
      },
      narrowing,
    );
  }

  if (!isPlainObject(derived) || !isPlainObject(narrowing)) return beside;

  // Closing an object admits less. Anything else said of the fields it does not list would have
  // to be weighed against what the document says of them, which `allOf` does without weighing.
  const closes = narrowing.additionalProperties === false;
  if (
    narrowing.additionalProperties !== undefined &&
    !closes &&
    !isDeepStrictEqual(
      narrowing.additionalProperties,
      derived.additionalProperties,
    )
  ) {
    return beside;
  }

  const documented = isRecord(derived.properties) ? derived.properties : {};
  const properties: Record<string, unknown> = { ...documented };
  for (const [name, stated] of Object.entries(
    isRecord(narrowing.properties) ? narrowing.properties : {},
  )) {
    const at = `${where}.${name}`;
    if (Object.hasOwn(documented, name)) {
      setKey(
        properties,
        name,
        narrowInto(documented[name], stated, at, problems),
      );
    } else if (derived.additionalProperties === false) {
      // A field the document refuses: stating it would be admitting what the upstream does not.
      problems.push(
        `${at} is narrowed, and the document has no such field there`,
      );
    } else if (admitsAnything(derived.additionalProperties)) {
      setKey(properties, name, stated);
    } else {
      // A name the document held to a schema of its own, through `additionalProperties`: a
      // field declared here is exempt from that, so what held it has to be kept beside what is
      // stated. A dictionary of strings does not gain a number by naming one of its keys.
      setKey(
        properties,
        name,
        narrowInto(derived.additionalProperties, stated, at, problems),
      );
    }
  }

  const required = [
    ...new Set([...strings(derived.required), ...strings(narrowing.required)]),
  ];
  // In the order the document wrote them, with what changed written where it was.
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(derived)) {
    if (key === "required" || key === "additionalProperties") continue;
    setKey(result, key, key === "properties" ? properties : value);
  }
  setKey(result, "properties", properties);
  if (required.length > 0) setKey(result, "required", required);
  if (closes) setKey(result, "additionalProperties", false);
  else if (derived.additionalProperties !== undefined) {
    setKey(result, "additionalProperties", derived.additionalProperties);
  }
  return withAnnotations(result, narrowing);
}

// What a narrowing says of what it narrows, its description say, kept over what the document
// says: it is the operation's own account of the field, and the more specific of the two.
function withAnnotations(
  merged: Record<string, unknown>,
  narrowing: Schema,
): Record<string, unknown> {
  for (const key of ANNOTATIONS) {
    if (Object.hasOwn(narrowing, key)) setKey(merged, key, narrowing[key]);
  }
  return merged;
}
