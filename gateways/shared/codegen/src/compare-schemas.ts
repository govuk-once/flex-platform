import { isDeepStrictEqual } from "node:util";

import type { GatewaySchemas } from "@repo/gateway-types";
import { isRecord } from "@repo/utils/is-record";
import { ownValue } from "@repo/utils/own-value";
import { sortedNames } from "@repo/utils/sorted-names";
import { stringsIn } from "@repo/utils/strings-in";

import type { SchemaVersion } from "./schema-store.ts";

// Whether one version of a gateway's schemas can follow another without breaking a caller written
// against the first. The two sides of a call run in opposite directions: an input may come to
// accept more and must never accept less, since a caller goes on sending what it sent; an outcome
// may come to promise more and must never promise less, since a caller goes on reading what it
// read. So every difference is first read for its effect on what a schema admits, and only then
// for which side of the call it is on.
//
// Subsumption between JSON Schemas is not decidable in general, and nothing here attempts it.
// The keywords a gateway's schemas are written with are read one by one, and whatever is left,
// or does not fit, counts as a break: a change refused that was safe costs a look, where one
// accepted that was not costs every caller.

export type Direction = "input" | "output";

export interface SchemaComparison {
  // Differences a caller written against the earlier version does not survive.
  readonly breaking: readonly string[];
  // Differences in shape that it does. Annotations are not differences at all.
  readonly compatible: readonly string[];
}

// What a difference does to the values a schema admits. "unknown" is a difference nothing here
// can place, which is a break in either direction.
type Effect = "narrows" | "widens" | "unknown";

// Where a schema sits in the one that holds it. A schema under a negation, a condition or a
// counted `contains` does not act on the whole the way it acts on itself, so which side of the
// call it is on no longer says which changes are safe: there, any difference is a break.
type Position = Direction | "uncertain";

// How a definition read in each position is named, where it is reported.
const POSITIONS: Readonly<Record<Position, string>> = {
  input: "as input",
  output: "as output",
  uncertain: "where it is negated or conditional",
};
const POSITION_ORDER: readonly Position[] = ["input", "output", "uncertain"];

// Keywords that describe a schema without constraining a value.
const ANNOTATIONS: ReadonlySet<string> = new Set([
  "$comment",
  "default",
  "deprecated",
  "description",
  "example",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);

// Bounds a value must reach, and bounds it must stay within: raising the first or lowering the
// second admits less.
const LOWER_BOUNDS = [
  "exclusiveMinimum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
];
const UPPER_BOUNDS = [
  "exclusiveMaximum",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
];
// Constraints with no order to them: one added admits less, one removed admits more, and one
// changed cannot be placed.
const UNORDERED = ["format", "multipleOf", "pattern"];

// What a bound says when it is left out. A bound written at its own default says what saying
// nothing said, so neither adding nor removing it there is a difference, and one removed from
// below its default tightens rather than loosens: without `minContains`, an array has to hold a
// match, so `minContains: 0` taken away is a bound arriving, not one going.
const BOUND_DEFAULTS: Readonly<Record<string, number>> = {
  exclusiveMaximum: Number.POSITIVE_INFINITY,
  exclusiveMinimum: Number.NEGATIVE_INFINITY,
  maxContains: Number.POSITIVE_INFINITY,
  maxItems: Number.POSITIVE_INFINITY,
  maxLength: Number.POSITIVE_INFINITY,
  maxProperties: Number.POSITIVE_INFINITY,
  maximum: Number.POSITIVE_INFINITY,
  minContains: 1,
  minItems: 0,
  minLength: 0,
  minProperties: 0,
  minimum: Number.NEGATIVE_INFINITY,
};

// The two bounds that count matches rather than measure a value. With no `contains` to count
// they constrain nothing, and a `contains` that came or went is a difference in its own right.
const CONTAINS_BOUNDS = ["maxContains", "minContains"];

const SUBSCHEMA_MAPS = [
  "$defs",
  "dependentSchemas",
  "patternProperties",
  "properties",
];
const SUBSCHEMA_LISTS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SUBSCHEMAS = [
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
];

// A reference resolved more deeply than any schema is written is one that comes back on itself
// through a definition under another name.
const MAX_DEPTH = 64;

type Schema = Readonly<Record<string, unknown>>;
type Defs = Readonly<Record<string, unknown>>;

// Keywords whose subschema does not act on the whole the way it acts on itself: `not` reverses
// it, `if` chooses between `then` and `else` rather than admitting anything of its own, a
// `contains` under a `maxContains` refuses an array for holding one match too many, and a branch
// of a `oneOf` that admits more can leave a value matching two, which the whole then refuses. A
// definition reached through any of them is read as neither side of the call, so freezing a
// `oneOf` covers what it refers to and not only what it is written with.
function reversesEffect(key: string, schema: Schema): boolean {
  if (key === "not" || key === "if" || key === "oneOf") return true;
  return key === "contains" && Object.hasOwn(schema, "maxContains");
}

// A boolean schema as the object it abbreviates. `false` admits nothing and has no such object,
// so it is handled where it can appear.
const asSchema = (value: unknown): unknown => (value === true ? {} : value);

const byJson = (values: readonly unknown[]): string[] =>
  sortedNames(values.map((value) => JSON.stringify(value)));

// A schema with its annotations taken out and what has no order put in one, so two schemas that
// constrain the same way compare equal. Only a schema's own positions are read as schemas: a
// property may itself be named "description".
function shapeOf(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const shape: Record<string, unknown> = {};
  for (const key of sortedNames(Object.keys(value))) {
    if (ANNOTATIONS.has(key)) continue;
    const held = value[key];
    if (SUBSCHEMA_MAPS.includes(key) && isRecord(held)) {
      shape[key] = Object.fromEntries(
        sortedNames(Object.keys(held)).map((name) => [
          name,
          shapeOf(held[name]),
        ]),
      );
    } else if (SUBSCHEMA_LISTS.includes(key) && Array.isArray(held)) {
      shape[key] = held.map(shapeOf);
    } else if (SUBSCHEMAS.includes(key)) {
      shape[key] = shapeOf(held);
    } else if (key === "required" || key === "type" || key === "enum") {
      shape[key] = Array.isArray(held) ? byJson(held) : held;
    } else {
      shape[key] = held;
    }
  }
  return shape;
}

const sameShape = (previous: unknown, next: unknown): boolean =>
  isDeepStrictEqual(shapeOf(previous), shapeOf(next));

// Two values of one keyword, read the way that keyword is read. What a value means depends on
// what holds it: `patternProperties` and `dependentSchemas` hold schemas under names of their
// own, `prefixItems` holds a list of them, and `dependentRequired` holds no schema at all. A map
// read as though it were itself a schema loses any name that reads as an annotation, so a
// pattern named "description" would be dropped from both sides and a change under it never seen.
// Each value is put back under its own key, which is the context, rather than that context being
// described again here.
const sameAt = (key: string, previous: unknown, next: unknown): boolean =>
  isDeepStrictEqual(shapeOf({ [key]: previous }), shapeOf({ [key]: next }));

// The types a schema names, or undefined when it names none and so admits any. Ajv reads
// OpenAPI's `nullable` beside a type as null being one of them.
function typesOf(schema: Schema): ReadonlySet<string> | undefined {
  const declared = Array.isArray(schema.type)
    ? stringsIn(schema.type)
    : typeof schema.type === "string"
      ? [schema.type]
      : undefined;
  if (declared === undefined) return undefined;
  return new Set(schema.nullable === true ? [...declared, "null"] : declared);
}

// Every integer is a number, so a schema that takes numbers takes integers.
const covers = (types: ReadonlySet<string>, type: string): boolean =>
  types.has(type) || (type === "integer" && types.has("number"));

// The values a schema lists, or undefined when it lists none. `const` and `enum` each restrict,
// so a schema carrying both admits only what the two agree on, and neither hides a change to the
// other: `{ const: "a" }` that gains `enum: ["b"]` comes to admit nothing.
function valuesOf(schema: Schema): readonly unknown[] | undefined {
  const listed = Array.isArray(schema.enum)
    ? (schema.enum as unknown[])
    : undefined;
  if (!Object.hasOwn(schema, "const")) return listed;
  if (listed === undefined) return [schema.const];
  return listed.filter((value) => isDeepStrictEqual(value, schema.const));
}

// Whether a property name is one a pattern governs, or undefined when the pattern cannot be read
// as one. Ajv compiles these with unicode mode, so they are read the same way here.
function matchesName(pattern: string, name: string): boolean | undefined {
  try {
    return new RegExp(pattern, "u").test(name);
  } catch {
    return undefined;
  }
}

// A name governed by more than one pattern, or by one that cannot be read: what held it is more
// than a single schema, so what a declaration of it keeps cannot be read from one.
const UNPLACEABLE = Symbol("unplaceable");

class Comparison {
  readonly breaking: string[] = [];
  readonly compatible: string[] = [];
  // Definitions already read in a direction, so one used in ten places is reported once and a
  // definition that refers to itself is not followed for ever.
  readonly #read = new Set<string>();
  readonly #previous: Defs;
  readonly #next: Defs;

  constructor(previous: Defs, next: Defs) {
    this.#previous = previous;
    this.#next = next;
  }

  add(effect: Effect, position: Position, where: string, what: string): void {
    const breaks =
      position === "uncertain" ||
      effect === "unknown" ||
      (position === "input" ? effect === "narrows" : effect === "widens");
    (breaks ? this.breaking : this.compatible).push(`${where}: ${what}`);
  }

  breaks(where: string, what: string): void {
    this.breaking.push(`${where}: ${what}`);
  }

  survives(where: string, what: string): void {
    this.compatible.push(`${where}: ${what}`);
  }

  definition(name: string, position: Position): void {
    const key = `${position}:${name}`;
    if (this.#read.has(key)) return;
    this.#read.add(key);
    const previous = ownValue(this.#previous, name);
    const next = ownValue(this.#next, name);
    // One that is gone is reported as that, once, where the definitions are listed.
    if (previous === undefined || next === undefined) return;
    this.schema(
      previous,
      next,
      position,
      `defs.${name} (${POSITIONS[position]})`,
    );
  }

  // A reference with nothing beside it but annotations stands for its definition; one with
  // constraints beside it is read as written, since both then apply.
  #resolve(value: unknown, defs: Defs): unknown {
    if (!isRecord(value) || typeof value.$ref !== "string") return value;
    const beside = Object.keys(value).filter(
      (key) => key !== "$ref" && !ANNOTATIONS.has(key),
    );
    return beside.length === 0 ? (ownValue(defs, value.$ref) ?? value) : value;
  }

  schema(
    previousValue: unknown,
    nextValue: unknown,
    position: Position,
    where: string,
    depth = 0,
  ): void {
    if (sameShape(previousValue, nextValue)) {
      // The same reference on both sides says the same only if the definition still does.
      this.#references(previousValue, position);
      return;
    }
    if (depth > MAX_DEPTH) {
      this.add("unknown", position, where, "is nested too deeply to compare");
      return;
    }

    // `false` admits nothing: becoming it admits less than anything did, and leaving it more.
    if (previousValue === false || nextValue === false) {
      this.add(
        nextValue === false ? "narrows" : "widens",
        position,
        where,
        nextValue === false ? "now admits nothing" : "no longer admits nothing",
      );
      return;
    }

    const previous = asSchema(previousValue);
    const next = asSchema(nextValue);
    if (!isRecord(previous) || !isRecord(next)) {
      this.add("unknown", position, where, "is not a schema on both sides");
      return;
    }

    if (typeof previous.$ref === "string" || typeof next.$ref === "string") {
      if (previous.$ref === next.$ref && typeof next.$ref === "string") {
        this.definition(next.$ref, position);
      } else if (
        typeof previous.$ref === "string" &&
        typeof next.$ref === "string"
      ) {
        // A definition is a type a caller names, so another in its place is another type.
        this.add(
          "unknown",
          position,
          where,
          `refers to "${next.$ref}" where it referred to "${previous.$ref}"`,
        );
        return;
      } else {
        const resolvedPrevious = this.#resolve(previous, this.#previous);
        const resolvedNext = this.#resolve(next, this.#next);
        if (resolvedPrevious === previous && resolvedNext === next) {
          this.add(
            "unknown",
            position,
            where,
            "has a reference on one side that cannot be read as its definition",
          );
          return;
        }
        this.schema(resolvedPrevious, resolvedNext, position, where, depth + 1);
        return;
      }
    }

    // What is written beside a reference applies as well, so it is read like any other schema.
    this.#keywords(
      withoutKey(previous, "$ref"),
      withoutKey(next, "$ref"),
      position,
      where,
      depth,
    );
  }

  #references(value: unknown, position: Position): void {
    eachReference(value, position, (name, at) => {
      this.definition(name, at);
    });
  }

  #keywords(
    previous: Schema,
    next: Schema,
    position: Position,
    where: string,
    depth: number,
  ): void {
    const keys = sortedNames(
      new Set([...Object.keys(previous), ...Object.keys(next)]),
    ).filter((key) => !ANNOTATIONS.has(key));
    const handled = new Set<string>();
    const take = (...names: string[]): boolean => {
      const present = names.some((name) => keys.includes(name));
      for (const name of names) handled.add(name);
      return present;
    };

    if (take("type", "nullable")) this.#types(previous, next, position, where);
    if (take("enum", "const")) this.#values(previous, next, position, where);

    for (const key of [...LOWER_BOUNDS, ...UPPER_BOUNDS]) {
      if (!take(key)) continue;
      // Nothing counts matches without a `contains` to count; one that came or went is read
      // below, as the difference it is.
      if (
        CONTAINS_BOUNDS.includes(key) &&
        !(
          Object.hasOwn(previous, "contains") && Object.hasOwn(next, "contains")
        )
      ) {
        continue;
      }
      this.#bound(
        key,
        previous[key],
        next[key],
        LOWER_BOUNDS.includes(key),
        position,
        where,
      );
    }

    for (const key of UNORDERED) {
      if (!take(key)) continue;
      const before = previous[key];
      const after = next[key];
      if (isDeepStrictEqual(before, after)) continue;
      this.add(
        before === undefined
          ? "narrows"
          : after === undefined
            ? "widens"
            : "unknown",
        position,
        `${where}.${key}`,
        before === undefined
          ? `is now ${JSON.stringify(after)}`
          : after === undefined
            ? `is no longer ${JSON.stringify(before)}`
            : `changed from ${JSON.stringify(before)} to ${JSON.stringify(after)}`,
      );
    }

    if (take("uniqueItems")) {
      const before = previous.uniqueItems === true;
      const after = next.uniqueItems === true;
      if (before !== after) {
        this.add(
          after ? "narrows" : "widens",
          position,
          `${where}.uniqueItems`,
          after ? "items must now be unique" : "items need no longer be unique",
        );
      }
    }

    if (take("required")) this.#required(previous, next, position, where);
    if (take("properties")) {
      this.#properties(previous, next, position, where, depth);
    }
    if (take("additionalProperties")) {
      this.#additional(previous, next, position, where, depth);
    }
    if (take("items")) {
      // Leaving `items` out admits any element, which is what the empty schema says.
      this.schema(
        previous.items ?? {},
        next.items ?? {},
        position,
        `${where}.items`,
        depth + 1,
      );
    }
    if (take("allOf")) {
      this.#every(previous.allOf, next.allOf, position, where, depth);
    }
    if (take("anyOf")) {
      this.#either(previous.anyOf, next.anyOf, position, where, depth);
    }
    if (take("oneOf")) {
      this.#exclusive(previous.oneOf, next.oneOf, position, where);
    }

    // Whatever else a schema is written with says the same or is a break: nothing here knows
    // which way a difference in it leans.
    for (const key of keys) {
      if (handled.has(key) || sameAt(key, previous[key], next[key])) continue;
      this.add(
        "unknown",
        position,
        `${where}.${key}`,
        "changed in a way that cannot be read as safe",
      );
    }
  }

  #types(
    previous: Schema,
    next: Schema,
    position: Position,
    where: string,
  ): void {
    const before = typesOf(previous);
    const after = typesOf(next);
    const spell = (types: ReadonlySet<string> | undefined): string =>
      types === undefined ? "any type" : sortedNames(types).join(" | ");
    if (spell(before) === spell(after)) return;

    // Whether everything admitted before still is, and whether nothing else now is.
    const keeps =
      after === undefined ||
      (before !== undefined &&
        [...before].every((type) => covers(after, type)));
    const adds =
      before === undefined ||
      (after !== undefined && [...after].every((type) => covers(before, type)));
    // Spelt differently and admitting the same: "number" beside "integer" adds nothing.
    if (keeps && adds) return;
    this.add(
      keeps ? "widens" : adds ? "narrows" : "unknown",
      position,
      `${where}.type`,
      `changed from ${spell(before)} to ${spell(after)}`,
    );
  }

  #values(
    previous: Schema,
    next: Schema,
    position: Position,
    where: string,
  ): void {
    const before = valuesOf(previous);
    const after = valuesOf(next);
    if (before === undefined && after === undefined) return;
    // Named for the keyword the values are written with, which either side may be the one to
    // carry: what is compared is what the two of them together admit.
    const at = `${where}.${Object.hasOwn(previous, "enum") || Object.hasOwn(next, "enum") ? "enum" : "const"}`;
    if (before === undefined || after === undefined) {
      this.add(
        before === undefined ? "narrows" : "widens",
        position,
        at,
        before === undefined
          ? "is now limited to the values listed"
          : "is no longer limited to the values listed",
      );
      return;
    }
    const had = new Set(byJson(before));
    const has = new Set(byJson(after));
    const added = [...has].filter((value) => !had.has(value));
    const removed = [...had].filter((value) => !has.has(value));
    if (added.length > 0) {
      this.add("widens", position, at, `added ${added.join(", ")}`);
    }
    if (removed.length > 0) {
      this.add("narrows", position, at, `removed ${removed.join(", ")}`);
    }
  }

  #bound(
    key: string,
    before: unknown,
    after: unknown,
    lower: boolean,
    position: Position,
    where: string,
  ): void {
    if (isDeepStrictEqual(before, after)) return;
    const at = `${where}.${key}`;
    if (
      (before !== undefined && typeof before !== "number") ||
      (after !== undefined && typeof after !== "number")
    ) {
      this.add("unknown", position, at, "is not a number on both sides");
      return;
    }
    // A bound left out is whatever its keyword means by saying nothing, so what is compared is
    // what each version holds a value to, not whether the keyword is written.
    const fallback = ownValue(BOUND_DEFAULTS, key);
    if (fallback === undefined) {
      this.add("unknown", position, at, "is not a bound that can be placed");
      return;
    }
    const previous = before ?? fallback;
    const next = after ?? fallback;
    if (previous === next) return;
    this.add(
      next > previous === lower ? "narrows" : "widens",
      position,
      at,
      before === undefined
        ? `is now ${JSON.stringify(after)}`
        : after === undefined
          ? `is no longer ${JSON.stringify(before)}`
          : `changed from ${String(before)} to ${String(after)}`,
    );
  }

  #required(
    previous: Schema,
    next: Schema,
    position: Position,
    where: string,
  ): void {
    const before = new Set(stringsIn(previous.required));
    const after = new Set(stringsIn(next.required));
    for (const name of sortedNames(after)) {
      if (!before.has(name)) {
        this.add(
          "narrows",
          position,
          `${where}.required`,
          `"${name}" is now required`,
        );
      }
    }
    for (const name of sortedNames(before)) {
      if (!after.has(name)) {
        this.add(
          "widens",
          position,
          `${where}.required`,
          `"${name}" is no longer required`,
        );
      }
    }
  }

  // What held a name before it was declared: the value schema of a dictionary that covered it,
  // or nothing more than the object being open or closed to it.
  #governing(schema: Schema, name: string): unknown {
    const patterns = isRecord(schema.patternProperties)
      ? schema.patternProperties
      : {};
    const matched: unknown[] = [];
    for (const [pattern, held] of Object.entries(patterns)) {
      const hit = matchesName(pattern, name);
      if (hit === undefined) return UNPLACEABLE;
      if (hit) matched.push(held);
    }
    if (matched.length > 1) return UNPLACEABLE;
    // A pattern that governs the name is what applies; `additionalProperties` reaches only a
    // name no pattern matched.
    return matched.length === 1
      ? matched[0]
      : (schema.additionalProperties ?? true);
  }

  #properties(
    previous: Schema,
    next: Schema,
    position: Position,
    where: string,
    depth: number,
  ): void {
    const before = isRecord(previous.properties) ? previous.properties : {};
    const after = isRecord(next.properties) ? next.properties : {};

    for (const name of sortedNames(Object.keys(after))) {
      const at = `${where}.properties.${name}`;
      if (Object.hasOwn(before, name)) {
        this.schema(before[name], after[name], position, at, depth + 1);
        continue;
      }
      const governing = this.#governing(previous, name);
      if (governing === UNPLACEABLE) {
        this.add(
          "unknown",
          position,
          at,
          "was added under more than one pattern, so what held the name cannot be read",
        );
        continue;
      }
      // A dictionary already said what values the name carried, and a declaration of it has to
      // keep saying that: an outcome whose values were strings does not quietly gain a number.
      if (constrains(governing)) {
        this.schema(governing, after[name], position, at, depth + 1);
        continue;
      }
      if (position === "output") {
        // Nothing was promised under the name, so more to read breaks no one who was not
        // reading it. Declaring it is what puts it in the contract; what an outcome does with a
        // field it does not declare is a separate question, and not one a caller was told.
        this.survives(at, "was added");
        continue;
      }
      // A name an open object took any value under is now held to a schema; a closed one
      // refused the name, and now takes it.
      this.add(
        governing === false ? "widens" : "narrows",
        position,
        at,
        "was added",
      );
    }
    for (const name of sortedNames(Object.keys(before))) {
      if (Object.hasOwn(after, name)) continue;
      // Either way a caller names it: one goes on sending it, the other goes on reading it.
      this.breaks(`${where}.properties.${name}`, "was removed");
    }
  }

  #additional(
    previous: Schema,
    next: Schema,
    position: Position,
    where: string,
    depth: number,
  ): void {
    const before = previous.additionalProperties ?? true;
    const after = next.additionalProperties ?? true;
    const at = `${where}.additionalProperties`;
    if (sameShape(before, after)) return;

    // Outcome data that passes validation is forwarded to the caller unchanged, fields beyond
    // what is declared included. Whether an outcome admits those at all is a separate question,
    // answered against the upstream it validates: a closed one refuses the response outright.
    // What neither version did is declare the field, so a caller reading what the contract names
    // is told the same either way, and that is what this reads.
    if (
      position === "output" &&
      typeof before === "boolean" &&
      typeof after === "boolean"
    ) {
      this.survives(at, `changed from ${String(before)} to ${String(after)}`);
      return;
    }
    this.schema(before, after, position, at, depth + 1);
  }

  // `allOf`: every branch holds, so a branch that admits less makes the whole admit less.
  #every(
    before: unknown,
    after: unknown,
    position: Position,
    where: string,
    depth: number,
  ): void {
    const previous = Array.isArray(before) ? (before as unknown[]) : [];
    const next = Array.isArray(after) ? (after as unknown[]) : [];
    if (previous.length !== next.length) {
      this.add(
        "unknown",
        position,
        `${where}.allOf`,
        `has ${String(next.length)} parts where it had ${String(previous.length)}`,
      );
      return;
    }
    previous.forEach((branch, index) => {
      this.schema(
        branch,
        next[index],
        position,
        `${where}.allOf.${String(index)}`,
        depth + 1,
      );
    });
  }

  // `anyOf`: a value is admitted when any branch admits it, so a branch that admits more makes
  // the whole admit more and one added or removed moves it the same way. A branch that is only a
  // type already admits every value of that type, so what is listed beside it, the values an
  // open enum knows about, can change without the whole admitting anything it did not.
  #either(
    before: unknown,
    after: unknown,
    position: Position,
    where: string,
    depth: number,
  ): void {
    const at = `${where}.anyOf`;
    const previous = Array.isArray(before) ? (before as unknown[]) : undefined;
    const next = Array.isArray(after) ? (after as unknown[]) : undefined;
    if (previous === undefined || next === undefined) {
      this.add(
        previous === undefined ? "narrows" : "widens",
        position,
        at,
        previous === undefined ? "was added" : "was removed",
      );
      return;
    }

    const open = [...bareTypes(previous)].filter((type) =>
      bareTypes(next).has(type),
    );
    const known = (branches: readonly unknown[]): unknown[] =>
      branches.filter((branch) => isKnownValueOf(branch, open));
    const rest = (branches: readonly unknown[]): unknown[] =>
      branches.filter((branch) => !isKnownValueOf(branch, open));

    // Branch by branch, so annotations inside one are read past here as anywhere else.
    if (
      !isDeepStrictEqual(known(previous).map(shapeOf), known(next).map(shapeOf))
    ) {
      this.survives(
        at,
        "lists different known values of a type it admits in full",
      );
    }

    const previousRest = rest(previous);
    const nextRest = rest(next);
    if (previousRest.length === nextRest.length) {
      previousRest.forEach((branch, index) => {
        this.schema(
          branch,
          nextRest[index],
          position,
          `${at}.${String(index)}`,
          depth + 1,
        );
      });
      return;
    }
    const [shorter, longer] =
      previousRest.length < nextRest.length
        ? [previousRest, nextRest]
        : [nextRest, previousRest];
    const kept = shorter.every((branch) =>
      longer.some((other) => sameShape(branch, other)),
    );
    this.add(
      !kept
        ? "unknown"
        : nextRest.length > previousRest.length
          ? "widens"
          : "narrows",
      position,
      at,
      `has ${String(next.length)} branches where it had ${String(previous.length)}`,
    );
  }

  // `oneOf`: a value is admitted when exactly one branch admits it, so what a branch does to the
  // whole is not what it does on its own. A branch that comes to admit more can take a value
  // another already admitted, leaving two that match and the whole refusing what it took before;
  // a branch removed can leave a value that matched two matching one, and the whole taking what
  // it refused. Every change runs both ways at once, and which way it lands is a question about
  // the branches together that nothing here answers, so only a `oneOf` whose branches say what
  // they said says the same. The union rules `anyOf` is read by are not applied: the values an
  // open enum lists beside a type it admits in full are, under `oneOf`, the values two branches
  // both match.
  #exclusive(
    before: unknown,
    after: unknown,
    position: Position,
    where: string,
  ): void {
    const at = `${where}.oneOf`;
    const previous = Array.isArray(before) ? (before as unknown[]) : undefined;
    const next = Array.isArray(after) ? (after as unknown[]) : undefined;
    if (previous === undefined || next === undefined) {
      this.add(
        "unknown",
        position,
        at,
        previous === undefined ? "was added" : "was removed",
      );
      return;
    }
    if (previous.length !== next.length) {
      this.add(
        "unknown",
        position,
        at,
        `has ${String(next.length)} branches where it had ${String(previous.length)}`,
      );
      return;
    }
    previous.forEach((branch, index) => {
      if (sameShape(branch, next[index])) {
        // Unchanged as written, which says the same only if what it refers to still does. Read
        // as uncertain, not as the side the `oneOf` is on: a definition that comes to admit more
        // can leave its branch overlapping the one beside it, which is the change this refuses
        // when it is written out rather than referred to.
        this.#references(branch, "uncertain");
        return;
      }
      this.add(
        "unknown",
        position,
        `${at}.${String(index)}`,
        "changed, and a branch of a oneOf that changes can leave another matching too",
      );
    });
  }
}

// Whether a schema holds a value to anything: `true`, the empty schema and one written with
// nothing but annotations all admit every value, so a name they governed was never promised one.
function constrains(value: unknown): boolean {
  const shape = shapeOf(asSchema(value));
  return isRecord(shape) && Object.keys(shape).length > 0;
}

// Every definition a schema names, with the position it is named in. Read from the schema as
// written rather than from what a comparison reached, so a composition that changed too much to
// compare does not take the definitions its branches name down with it.
function eachReference(
  value: unknown,
  position: Position,
  visit: (name: string, position: Position) => void,
): void {
  if (!isRecord(value)) return;
  if (typeof value.$ref === "string") visit(value.$ref, position);
  for (const [key, held] of Object.entries(value)) {
    const at = reversesEffect(key, value) ? "uncertain" : position;
    if (SUBSCHEMA_MAPS.includes(key) && isRecord(held)) {
      for (const schema of Object.values(held)) {
        eachReference(schema, at, visit);
      }
    } else if (SUBSCHEMA_LISTS.includes(key) && Array.isArray(held)) {
      for (const schema of held) eachReference(schema, at, visit);
    } else if (SUBSCHEMAS.includes(key)) {
      eachReference(held, at, visit);
    }
  }
}

// Which side of a call each definition of one version is used on. A definition reached only
// through an input is read as an input and one reached both ways is read both ways, so reading it
// as the one never stands in for reading it as the other.
function usageOf(schemas: GatewaySchemas): ReadonlyMap<string, Set<Position>> {
  const defs: Defs = schemas.defs ?? {};
  const used = new Map<string, Set<Position>>();
  const pending: [unknown, Position][] = [];
  for (const operation of Object.values(schemas.operations)) {
    pending.push([operation.input, "input"]);
    for (const outcome of Object.values(operation.outcomes)) {
      pending.push([outcome, "output"]);
    }
  }
  for (let held = pending.pop(); held !== undefined; held = pending.pop()) {
    const [value, position] = held;
    eachReference(value, position, (name, at) => {
      const positions = used.get(name) ?? new Set<Position>();
      used.set(name, positions);
      if (positions.has(at)) return;
      positions.add(at);
      // A definition names definitions of its own, from the side it is reached on.
      const body = ownValue(defs, name);
      if (body !== undefined) pending.push([body, at]);
    });
  }
  return used;
}

function withoutKey(schema: Schema, key: string): Schema {
  return Object.fromEntries(
    Object.entries(schema).filter(([name]) => name !== key),
  );
}

// The types a union admits in full: those of its branches that say nothing but a type.
function bareTypes(branches: readonly unknown[]): ReadonlySet<string> {
  const types = new Set<string>();
  for (const branch of branches) {
    const shape = shapeOf(branch);
    if (!isRecord(shape)) continue;
    if (Object.keys(shape).length === 1 && typeof shape.type === "string") {
      types.add(shape.type);
    }
  }
  return types;
}

const JSON_TYPE: Readonly<Record<string, string>> = {
  boolean: "boolean",
  number: "number",
  string: "string",
};

// A branch that only lists values, every one of a type the union admits in full anyway.
function isKnownValueOf(branch: unknown, open: readonly string[]): boolean {
  const shape = shapeOf(branch);
  if (!isRecord(branch) || !isRecord(shape)) return false;
  // Read from the branch as written: its shape holds the values as text, to compare them by.
  const values = valuesOf(branch);
  if (values === undefined) return false;
  const others = Object.keys(shape).filter(
    (key) => key !== "enum" && key !== "const" && key !== "type",
  );
  return (
    others.length === 0 &&
    values.every((value) => {
      const type = ownValue(JSON_TYPE, typeof value);
      return (
        type !== undefined &&
        (open.includes(type) ||
          (type === "number" &&
            Number.isInteger(value) &&
            open.includes("integer")))
      );
    })
  );
}

export function compareSchemas(
  previous: GatewaySchemas,
  next: GatewaySchemas,
): SchemaComparison {
  const previousDefs: Defs = previous.defs ?? {};
  const nextDefs: Defs = next.defs ?? {};
  const comparison = new Comparison(previousDefs, nextDefs);

  for (const name of sortedNames(Object.keys(previous.operations))) {
    const before = ownValue(previous.operations, name);
    const after = ownValue(next.operations, name);
    const where = `operations.${name}`;
    if (before === undefined) continue;
    if (after === undefined) {
      comparison.breaks(where, "was removed");
      continue;
    }

    comparison.schema(before.input, after.input, "input", `${where}.input`);

    for (const outcome of sortedNames(Object.keys(before.outcomes))) {
      const at = `${where}.outcomes.${outcome}`;
      const was = ownValue(before.outcomes, outcome);
      const is = ownValue(after.outcomes, outcome);
      if (is === undefined) comparison.breaks(at, "was removed");
      else comparison.schema(was, is, "output", at);
    }
    for (const outcome of sortedNames(Object.keys(after.outcomes))) {
      if (Object.hasOwn(before.outcomes, outcome)) continue;
      // A caller's switch over the outcomes was complete, and no longer is.
      comparison.breaks(`${where}.outcomes.${outcome}`, "was added");
    }
  }
  for (const name of sortedNames(Object.keys(next.operations))) {
    if (!Object.hasOwn(previous.operations, name)) {
      comparison.survives(`operations.${name}`, "was added");
    }
  }

  // A definition is a type the call contract exports under its name, whatever refers to it, so
  // every one is read: on each side of the call it is used on, taken from both versions, and on
  // both sides when nothing refers to it and nothing says which way it runs. What the comparison
  // reached on its way through the operations is already read and is not read twice.
  const usage = new Map<string, Set<Position>>();
  for (const version of [previous, next]) {
    for (const [name, positions] of usageOf(version)) {
      const merged = usage.get(name) ?? new Set<Position>();
      usage.set(name, merged);
      for (const position of positions) merged.add(position);
    }
  }

  for (const name of sortedNames(Object.keys(previousDefs))) {
    if (!Object.hasOwn(nextDefs, name)) {
      comparison.breaks(`defs.${name}`, "was removed");
      continue;
    }
    const used = usage.get(name);
    const positions: readonly Position[] =
      used === undefined || used.size === 0
        ? ["input", "output"]
        : POSITION_ORDER.filter((position) => used.has(position));
    for (const position of positions) comparison.definition(name, position);
  }
  for (const name of sortedNames(Object.keys(nextDefs))) {
    if (!Object.hasOwn(previousDefs, name)) {
      comparison.survives(`defs.${name}`, "was added");
    }
  }

  return { breaking: comparison.breaking, compatible: comparison.compatible };
}

// A version a caller of the one before it would not survive. Every break between every pair is
// reported together, since the command prints a message and nothing else.
export class SchemaCompatibilityError extends Error {
  readonly problems: readonly string[];

  constructor(gatewayId: string, problems: readonly string[]) {
    super(
      [
        `Gateway "${gatewayId}" has a version of its schemas that breaks the one before it:`,
        ...problems.map((problem) => `  - ${problem}`),
        "An incompatible contract needs a gateway of its own, under another id.",
      ].join("\n"),
    );
    this.name = "SchemaCompatibilityError";
    this.problems = problems;
  }
}

// Each version against the one before it, all the way back. Compatibility carries from pair to
// pair, so a history whose every step is safe is safe from its first version to its last; reading
// only the last step would let two versions added together hide a break in the first of them.
export function checkVersions(
  gatewayId: string,
  versions: readonly SchemaVersion[],
): void {
  const problems: string[] = [];
  versions.forEach((version, index) => {
    const earlier = versions[index - 1];
    if (earlier === undefined) return;
    const { breaking } = compareSchemas(earlier.schemas, version.schemas);
    problems.push(
      ...breaking.map(
        (problem) => `${earlier.version} -> ${version.version}: ${problem}`,
      ),
    );
  });
  if (problems.length > 0) {
    throw new SchemaCompatibilityError(gatewayId, problems);
  }
}
