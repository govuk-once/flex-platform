import type { JSONSchema } from "@repo/gateway-types";
import { isRecord } from "@repo/utils/is-record";
import { stringsIn } from "@repo/utils/strings-in";

import { docComment, documentationOf, type Documented } from "./doc-comment.ts";
import { isIdentifier } from "./output.ts";

// JSON Schema as a TypeScript type expression, for the call contract a caller writes against.
// It covers what the schemas describe: objects, arrays, scalars, enumerations, references to
// shared definitions and the combinators. Anything else becomes `unknown`, which admits every
// value the schema admits; the validators, not these types, decide what a request may contain.
//
// A schema states an object's shape across several places at once: `properties` here, `required`
// there, more of both inside `allOf`, and the rest behind a `$ref`. TypeScript has no equivalent
// of "this keyword applies only when the value is an object", so the object keywords a
// composition contributes are merged into one declaration and everything else is intersected
// around it. Keywords that only constrain objects are therefore applied to the object, and a
// schema that also admits null keeps admitting it.

export interface TypeContext {
  // Shared definition key -> the exported type name standing for it. A reference emits the
  // name rather than the shape, so a self-referential definition terminates.
  readonly defs: ReadonlyMap<string, string>;
  // The same definitions as schemas. A name says nothing about the fields it declares, which a
  // composition needs when it requires one of them.
  readonly schemas: ReadonlyMap<string, JSONSchema>;
}

// An expression and what it is made of, so a surrounding union, array or intersection knows to
// parenthesise it and can absorb one of its own kind. Carried rather than read back out of the
// text: a string literal can hold any punctuation, and `enum: ["<"]` would be mistaken for a
// nested type.
interface TypeExpression {
  readonly text: string;
  readonly kind: "leaf" | "array" | "union" | "intersection";
  // The members of a union or an intersection, so nesting one inside the same kind flattens.
  readonly members?: readonly TypeExpression[];
}

// How deep a schema is read: one level for each step into a subschema, through `properties`,
// `patternProperties`, `additionalProperties`, `items`, `prefixItems` and each branch of a
// composition. A reference costs nothing — it emits the definition's name and stops — so a
// schema factored into definitions stays shallow however large it is, and the one search that
// follows references between definitions ends itself by remembering where it has looked.
//
// Reaching this is an error rather than a widening. Nothing written by hand nests this far, so
// a schema that does is generated, or contains itself, and the schema is what wants looking at:
// quietly emitting `unknown` for the rest would hide it in a contract that still compiles.
// Reading on is not an option either, since the stack gives out at a depth that differs between
// machines, and a `RangeError` says nothing about which schema caused it.
const MAX_DEPTH = 100;

function tooDeep(): never {
  throw new Error(
    `Schema nests more than ${String(MAX_DEPTH)} levels deep. Look for a schema object that contains itself, or a definition inlined rather than referenced: a "$ref" is read as a name and does not nest.`,
  );
}

function tooMany(): never {
  throw new Error(
    `Schema has more than ${String(MAX_COMBINATIONS)} ways through its "anyOf" and "oneOf" branches. Factor the branches into a shared definition and reference it: a "$ref" is read as a name, so what it declares is written out once, where the definition is.`,
  );
}

function leaf(text: string): TypeExpression {
  return { text, kind: "leaf" };
}

// A member of a union or an intersection: only another of those needs brackets around it.
function grouped(expression: TypeExpression): string {
  return expression.kind === "union" || expression.kind === "intersection"
    ? `(${expression.text})`
    : expression.text;
}

// An array's element type. Anything but a single name needs brackets: `readonly T[][]` does not
// mean an array of arrays, and `readonly readonly T[][]` is not valid TypeScript at all.
function asElement(expression: TypeExpression): string {
  return expression.kind === "leaf" ? expression.text : `(${expression.text})`;
}

const NEVER = "never";

function combine(
  parts: readonly TypeExpression[],
  separator: " | " | " & ",
): TypeExpression {
  const kind = separator === " | " ? "union" : "intersection";
  // A union of unions is one union; the same for intersections. Nesting them would only add
  // brackets, and repeat what they have in common.
  const flattened = parts.flatMap((part) =>
    part.kind === kind && part.members !== undefined ? part.members : [part],
  );
  const unique = [
    ...new Map(flattened.map((part) => [part.text, part])).values(),
  ];
  if (unique.length === 0) return leaf("unknown");
  // A branch that admits nothing contributes nothing to a union, and leaves nothing of an
  // intersection. Writing it out would be correct but unreadable.
  if (kind === "intersection" && unique.some((part) => part.text === NEVER)) {
    return leaf(NEVER);
  }
  const members =
    kind === "union" ? unique.filter((part) => part.text !== NEVER) : unique;
  if (members.length === 0) return leaf(NEVER);
  if (members.length === 1) return members[0]!;
  return { text: members.map(grouped).join(separator), kind, members };
}

const union = (parts: readonly TypeExpression[]) => combine(parts, " | ");
const intersection = (parts: readonly TypeExpression[]) =>
  combine(parts, " & ");

// A scalar JSON value as a literal type. An object or array in an `enum` has no literal type
// worth writing, so it widens.
function literalType(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
      return String(value);
    default:
      return "unknown";
  }
}

function propertyKey(key: string): string {
  return isIdentifier(key) ? key : JSON.stringify(key);
}

// The object keywords a composition contributes, gathered as one shape.
interface ObjectShape {
  // Field -> every declaration of it, which `allOf` may spread over several branches.
  readonly properties: Map<string, TypeExpression[]>;
  readonly required: Set<string>;
  // Field -> what its schema says about it, from the first declaration that says anything.
  readonly docs: Map<string, Documented>;
  // The value types of `patternProperties`. TypeScript has no pattern-keyed index signature, so
  // they widen the one it does have rather than being dropped.
  readonly patterns: TypeExpression[];
  additional: unknown;
  // An object keyword was seen, so the composition describes an object even without a `type`.
  present: boolean;
}

interface DeferredUnion {
  readonly branches: readonly unknown[];
  readonly depth: number;
}

interface Composition {
  readonly shape: ObjectShape;
  // References, which stay named, in the order they were written.
  readonly refs: string[];
  // Branches that are not objects, already emitted.
  readonly parts: TypeExpression[];
  // `items` as each part of the composition declared them, and `prefixItems`, which names the
  // elements at the front by position. The bounds are the strictest each part gave.
  readonly items: unknown[];
  readonly prefixes: unknown[][];
  minItems: number | undefined;
  maxItems: number | undefined;
  // `anyOf` and `oneOf` branches, kept as schemas: each is read against everything enclosing it
  // rather than on its own, so what the composition requires, and what it admits besides an
  // object, still hold inside the branch. Each group carries the depth it was written at: the
  // branches are read later, and a union inside a branch is one level further in, which nothing
  // else would record.
  readonly unions: DeferredUnion[];
  // The types the schema admits, narrowed by each branch taken.
  types: readonly string[] | undefined;
}

function emptyComposition(): Composition {
  return {
    shape: {
      properties: new Map(),
      required: new Set(),
      docs: new Map(),
      patterns: [],
      additional: undefined,
      present: false,
    },
    refs: [],
    parts: [],
    items: [],
    prefixes: [],
    minItems: undefined,
    maxItems: undefined,
    unions: [],
    types: undefined,
  };
}

// The composition a branch absorbs into, copied one level deep: the containers, because
// absorbing writes to them, and not what they hold, because nothing writes to that. A
// TypeExpression is never altered once it is made, and the schemas kept in `items`, `prefixes`,
// `unions` and `additional` are the caller's, read and never modified. Copying those as well
// would duplicate every referenced schema for each branch expansion, and a structured clone
// would refuse a schema holding a function outright rather than reading it as `unknown`.
function cloneComposition(composition: Composition): Composition {
  return {
    shape: {
      properties: new Map(
        [...composition.shape.properties].map(([name, declarations]) => [
          name,
          [...declarations],
        ]),
      ),
      required: new Set(composition.shape.required),
      docs: new Map(composition.shape.docs),
      patterns: [...composition.shape.patterns],
      additional: composition.shape.additional,
      present: composition.shape.present,
    },
    refs: [...composition.refs],
    parts: [...composition.parts],
    items: [...composition.items],
    prefixes: [...composition.prefixes],
    minItems: composition.minItems,
    maxItems: composition.maxItems,
    unions: [...composition.unions],
    types: composition.types,
  };
}

// Ajv accepts OpenAPI's `nullable` beside a type and validates null against it, so a contract
// that left it out would reject a value the gateway takes.
function declaredTypes(schema: JSONSchema): readonly string[] | undefined {
  const declared = Array.isArray(schema.type)
    ? stringsIn(schema.type)
    : typeof schema.type === "string"
      ? [schema.type]
      : undefined;
  if (declared === undefined) return undefined;
  return schema.nullable === true && !declared.includes("null")
    ? [...declared, "null"]
    : declared;
}

// Every integer is a number, so the two overlap and the narrower one wins; the rest of the JSON
// Schema types are disjoint. An empty result is a schema no instance satisfies.
const NUMERIC: ReadonlySet<string> = new Set(["integer", "number"]);

function narrow(
  types: readonly string[] | undefined,
  by: readonly string[] | undefined,
): readonly string[] | undefined {
  if (types === undefined) return by;
  if (by === undefined) return types;
  const narrowed = new Set<string>();
  for (const type of types) {
    for (const other of by) {
      if (type === other) narrowed.add(type);
      else if (NUMERIC.has(type) && NUMERIC.has(other)) narrowed.add("integer");
    }
  }
  return [...narrowed];
}

// An enumeration names the values themselves, so it is emitted whole rather than read for the
// keywords a shape is made of.
function isEnumeration(schema: JSONSchema): boolean {
  return Object.hasOwn(schema, "enum") || Object.hasOwn(schema, "const");
}

// Whether a branch's object keywords can join the composition's shape. One that states a type
// other than "object", or that is an enumeration, constrains the value itself and is intersected
// instead.
function mergeable(branch: unknown): branch is JSONSchema {
  if (!isRecord(branch) || isEnumeration(branch)) return false;
  return branch.type === undefined || branch.type === "object";
}

// What a field's schema says about it. A field that only refers to a shared definition says
// nothing of its own, and an editor shows a field's comment rather than its type's, so what the
// definition says stands in: a schema factored into definitions documents its fields as well as
// one written out in full.
function propertyDocumentation(
  property: unknown,
  ctx: TypeContext,
): Documented {
  const own = documentationOf(property);
  const referred =
    isRecord(property) && typeof property.$ref === "string"
      ? documentationOf(ctx.schemas.get(property.$ref))
      : {};
  const description = own.description ?? referred.description;
  return {
    ...(description === undefined ? {} : { description }),
    ...(own.deprecated === true || referred.deprecated === true
      ? { deprecated: true }
      : {}),
  };
}

function absorb(
  schema: JSONSchema,
  into: Composition,
  ctx: TypeContext,
  depth: number,
): void {
  if (depth > MAX_DEPTH) tooDeep();
  const { shape } = into;

  // A reference keeps its name; in the 2020-12 dialect the keywords beside it still apply.
  if (typeof schema.$ref === "string") {
    const name = ctx.defs.get(schema.$ref);
    if (name === undefined) {
      // A reference is the key of a shared definition, which the contract declares as a type of
      // that name. A pointer into the schema itself, or into another document, is one the
      // validators resolve and this cannot name. It is refused rather than read as `unknown`:
      // the type would compile while describing nothing, where hoisting the definition into the
      // gateway's `defs` leaves both readers on the same declaration.
      throw new Error(
        schema.$ref.startsWith("#") || schema.$ref.includes("/")
          ? `Schema references "${schema.$ref}", which names no shared definition. A reference the contract can name is a key of the gateway's "defs"; declare the subschema there and reference it by that key.`
          : `Schema references shared definition "${schema.$ref}", which is not declared`,
      );
    }
    into.refs.push(schema.$ref);
  }

  // Every part of an `allOf` must hold at once, so each one narrows what the composition admits:
  // a branch that says the value is an object rules out the other forms the schema listed, and
  // one that says it may also be null keeps null.
  into.types = narrow(into.types, declaredTypes(schema));

  if (isRecord(schema.properties)) {
    shape.present = true;
    for (const [name, property] of Object.entries(schema.properties)) {
      const declarations = shape.properties.get(name) ?? [];
      declarations.push(expressionOf(property, ctx, depth + 1));
      shape.properties.set(name, declarations);
      if (!shape.docs.has(name)) {
        const documented = propertyDocumentation(property, ctx);
        if (docComment(documented) !== "") shape.docs.set(name, documented);
      }
    }
  }
  if (Object.hasOwn(schema, "required")) {
    shape.present = true;
    for (const name of stringsIn(schema.required)) shape.required.add(name);
  }
  if (isRecord(schema.patternProperties)) {
    shape.present = true;
    for (const pattern of Object.values(schema.patternProperties)) {
      shape.patterns.push(expressionOf(pattern, ctx, depth + 1));
    }
  }
  if (Object.hasOwn(schema, "additionalProperties")) {
    shape.present = true;
    // The strictest wins, as intersecting the branches does.
    if (
      shape.additional === undefined ||
      schema.additionalProperties === false
    ) {
      shape.additional = schema.additionalProperties;
    }
  }

  if (Object.hasOwn(schema, "items")) into.items.push(schema.items);
  if (Array.isArray(schema.prefixItems)) into.prefixes.push(schema.prefixItems);
  // Each part must hold, so the bounds are the strictest of them.
  if (typeof schema.minItems === "number") {
    into.minItems = Math.max(into.minItems ?? 0, schema.minItems);
  }
  if (typeof schema.maxItems === "number") {
    into.maxItems = Math.min(
      into.maxItems ?? Number.POSITIVE_INFINITY,
      schema.maxItems,
    );
  }

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      if (mergeable(branch)) {
        absorb(branch, into, ctx, depth + 1);
      } else {
        into.parts.push(expressionOf(branch, ctx, depth + 1));
      }
    }
  }

  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches) && branches.length > 0) {
      into.unions.push({ branches, depth });
    }
  }
}

// One branch of a union, read as part of the composition around it: its object keywords join
// the shape, its type narrows what the whole admits, and anything else it declares is
// intersected. `oneOf` becomes a union like `anyOf`, since TypeScript cannot say "exactly one".
function withBranch(
  composition: Composition,
  branch: unknown,
  ctx: TypeContext,
  depth: number,
): Composition {
  const next = cloneComposition(composition);
  if (!isRecord(branch)) {
    next.parts.push(leaf("unknown"));
    return next;
  }
  if (isEnumeration(branch)) {
    next.parts.push(expressionOf(branch, ctx, depth + 1));
    return next;
  }
  absorb(branch, next, ctx, depth + 1);
  return next;
}

// How many ways through a composition are written out. Nothing in these gateways' schemas comes
// close.
//
// Exceeding it is an error rather than a widening, for the reason MAX_DEPTH is. Dropping the
// branches is sound — the validators still decide what a request may contain — but it leaves a
// contract that compiles while admitting requests the gateway rejects, and says nothing about
// the one schema whose shape the caller most needs the compiler for. The schema is what wants
// looking at, and factoring its branches into a shared definition fixes it.
const MAX_COMBINATIONS = 24;

// One composition per way of taking the unions, so each carries everything enclosing it. A
// branch can hold unions of its own, so the budget is spent as combinations are completed
// rather than counted up front: nesting cannot multiply its way past it.
function expand(
  composition: Composition,
  ctx: TypeContext,
  depth: number,
  budget: { remaining: number },
): Composition[] {
  const [group, ...rest] = composition.unions;
  if (group === undefined) {
    if (budget.remaining <= 0) tooMany();
    budget.remaining -= 1;
    return [composition];
  }

  const base = { ...composition, unions: rest };
  const expanded: Composition[] = [];
  // Read at the depth the union was written at, not the one the composition started from: a
  // branch holding a union of its own is a level further in, and the guard has to see that.
  for (const branch of group.branches) {
    expanded.push(
      ...expand(withBranch(base, branch, ctx, group.depth), ctx, depth, budget),
    );
  }
  return expanded;
}

// The declaration of one field inside a shared definition, for a composition that requires a
// field only a reference declares. `looked` holds the definitions already searched, so a
// definition that references itself, or a pair that reference each other, ends the search where
// it comes back on itself rather than being counted out: a chain of any length is read to its
// end, and a field found there is one the caller's type requires.
function propertyOf(
  key: string,
  field: string,
  ctx: TypeContext,
  looked: ReadonlySet<string> = new Set(),
): unknown {
  if (looked.has(key)) return undefined;
  const schema = ctx.schemas.get(key);
  if (schema === undefined) return undefined;
  const searched = new Set([...looked, key]);
  const search = (candidate: unknown, level: number): unknown => {
    if (level > MAX_DEPTH) tooDeep();
    if (!isRecord(candidate)) return undefined;
    if (typeof candidate.$ref === "string") {
      return propertyOf(candidate.$ref, field, ctx, searched);
    }
    if (isRecord(candidate.properties) && field in candidate.properties) {
      return candidate.properties[field];
    }
    if (Array.isArray(candidate.allOf)) {
      for (const branch of candidate.allOf) {
        const found = search(branch, level + 1);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return search(schema, 0);
}

function objectFromShape(
  shape: ObjectShape,
  refs: readonly string[],
  ctx: TypeContext,
  depth: number,
): TypeExpression {
  // A field the composition requires but does not declare here: naming it makes the intersection
  // require it, since a property is required if any member requires it. A reference may declare
  // it, and then its type is what the reference says. Where nothing found declares it — it is
  // behind a union inside a definition, or the schema requires a field it never describes — the
  // field is still one every valid request carries, so it is named as `unknown`: leaving it out
  // would let a caller omit it and read the rejection from the gateway instead of the compiler.
  for (const field of shape.required) {
    if (shape.properties.has(field)) continue;
    let declaration: unknown;
    for (const key of refs) {
      declaration = propertyOf(key, field, ctx);
      if (declaration !== undefined) break;
    }
    shape.properties.set(field, [
      declaration === undefined
        ? leaf("unknown")
        : expressionOf(declaration, ctx, depth + 1),
    ]);
  }

  const members: string[] = [];
  const declared: TypeExpression[] = [];

  for (const [name, declarations] of shape.properties) {
    const type = intersection(declarations);
    declared.push(type);
    const optional = shape.required.has(name) ? "" : "?";
    members.push(
      `${docComment(shape.docs.get(name) ?? {})}readonly ${propertyKey(name)}${optional}: ${type.text};`,
    );
  }

  // Fields under a name the schema does not list. Leaving `additionalProperties` out admits them
  // as `true` does, and JSON Schema has no third state, but what a caller is offered does: only
  // a schema that says so is described as holding more than it lists. Left out, a validator goes
  // on admitting what an upstream adds or a caller's plain JavaScript sends, and the type stays
  // what was declared, so a contract never suggests fields that depend on the version of it a
  // caller happens to have. An object literal with a field of its own is then refused by the
  // compiler where the gateway would have taken it, which is the narrower of the two on purpose.
  const unconstrained = shape.additional === true;

  if (unconstrained) {
    members.push("readonly [key: string]: unknown;");
  } else if (shape.additional !== undefined) {
    // A schema for the rest, or `false` with patterns beside it: every name the schema admits
    // carries one of these, so one index signature holds them all, and TypeScript makes it
    // govern the declared properties as well, which JSON Schema does not, so their types join it.
    //
    // Patterns are read only here, where something is said about the names they do not match. A
    // schema that leaves `additionalProperties` out says what some names carry and nothing about
    // the rest, and an index signature typed from the patterns alone would offer a pattern's
    // type under every name: a validator takes `{ "unmatched": 123 }` where the pattern is
    // `^x-`, and `data.unmatched.toUpperCase()` would compile and fail. An index signature is a
    // promise about every name, so it is made only where the schema covers every name.
    const other = [
      ...(isRecord(shape.additional)
        ? [expressionOf(shape.additional, ctx, depth + 1)]
        : []),
      ...shape.patterns,
    ];
    if (other.length > 0) {
      const index = union([...other, ...declared, leaf("undefined")]);
      members.push(`readonly [key: string]: ${index.text};`);
    }
  }

  if (members.length === 0) {
    if (shape.additional === false) return leaf("Record<string, never>");
    // Nothing declared, and nothing said about the rest. On its own that is any object; beside a
    // reference it is the reference, and an index signature intersected with one would offer
    // every name the definition does not declare, reopening what naming it kept closed. `object`
    // says what is left, that the value is not a primitive, and takes nothing back.
    return leaf(refs.length > 0 ? "object" : "Record<string, unknown>");
  }
  // An index signature with nothing declared beside it is the whole of the type, and `Record`
  // says it in fewer characters. Whichever way the schema spelt it, it reads the same here.
  if (declared.length === 0 && unconstrained) {
    return leaf("Record<string, unknown>");
  }
  return leaf(`{ ${members.join(" ")} }`);
}

// The elements `prefixItems` names, by position: a part may name more of them than another, and
// where two name the same one both apply.
function prefixTypes(
  composition: Composition,
  ctx: TypeContext,
  depth: number,
): TypeExpression[] {
  const length = Math.max(0, ...composition.prefixes.map((p) => p.length));
  return Array.from({ length }, (_, index) =>
    intersection(
      composition.prefixes
        .filter((prefix) => index < prefix.length)
        .map((prefix) => expressionOf(prefix[index], ctx, depth + 1)),
    ),
  );
}

function arrayType(
  composition: Composition,
  ctx: TypeContext,
  depth: number,
): TypeExpression {
  const prefix = prefixTypes(composition, ctx, depth);
  const declarations = composition.items
    .filter((item) => item !== false)
    .map((item) => expressionOf(item, ctx, depth + 1));
  const element =
    declarations.length === 0 ? leaf("unknown") : intersection(declarations);
  // `items: false` admits nothing past the named elements, and neither does a length bound that
  // the names already fill.
  const closed =
    composition.items.includes(false) ||
    (composition.maxItems !== undefined &&
      composition.maxItems <= prefix.length);
  const rest = closed ? "" : `...${asElement(element)}[]`;

  if (prefix.length === 0) {
    return closed
      ? { text: "readonly []", kind: "array" }
      : { text: `readonly ${asElement(element)}[]`, kind: "array" };
  }

  // A named element is only there once the schema requires that many. An optional one takes the
  // same brackets an element needs: `[string | null?]` and `[readonly number[]?]` are not valid.
  const required = Math.min(composition.minItems ?? 0, prefix.length);
  const named = prefix.map((type, index) =>
    index < required ? type.text : `${asElement(type)}?`,
  );
  return {
    text: `readonly [${[...named, ...(rest === "" ? [] : [rest])].join(", ")}]`,
    kind: "array",
  };
}

function namedType(
  type: unknown,
  composition: Composition,
  ctx: TypeContext,
  depth: number,
): TypeExpression {
  switch (type) {
    case "object":
      return objectFromShape(composition.shape, composition.refs, ctx, depth);
    case "array":
      return arrayType(composition, ctx, depth);
    case "string":
      return leaf("string");
    case "integer":
    case "number":
      return leaf("number");
    case "boolean":
      return leaf("boolean");
    case "null":
      return leaf("null");
    default:
      return leaf("unknown");
  }
}

// What the composition admits, with its object keywords applied to the object form. Without a
// `type` those keywords are the only description there is, so they stand for the whole value;
// beside one they narrow only the object.
function ownType(
  composition: Composition,
  ctx: TypeContext,
  depth: number,
): TypeExpression | undefined {
  const { shape, types } = composition;

  if (types === undefined) {
    if (shape.present) {
      return objectFromShape(shape, composition.refs, ctx, depth);
    }
    return composition.items.length > 0
      ? arrayType(composition, ctx, depth)
      : undefined;
  }
  // Parts that narrowed to nothing describe a value no instance has.
  if (types.length === 0) return leaf("never");
  return union(types.map((type) => namedType(type, composition, ctx, depth)));
}

function emitComposition(
  composition: Composition,
  ctx: TypeContext,
  depth: number,
): TypeExpression {
  const own = ownType(composition, ctx, depth);
  const refs = composition.refs.map((key) => leaf(ctx.defs.get(key)!));

  return intersection([
    ...refs,
    ...(own === undefined ? [] : [own]),
    ...composition.parts,
  ]);
}

function expressionOf(
  schema: unknown,
  ctx: TypeContext,
  depth = 0,
): TypeExpression {
  if (depth > MAX_DEPTH) tooDeep();
  if (!isRecord(schema)) return leaf("unknown");

  if (Array.isArray(schema.enum)) {
    return union(schema.enum.map((value) => leaf(literalType(value))));
  }
  if (Object.hasOwn(schema, "const")) return leaf(literalType(schema.const));

  const composition = emptyComposition();
  absorb(schema, composition, ctx, depth);

  const combinations = expand(composition, ctx, depth, {
    remaining: MAX_COMBINATIONS,
  });

  return union(
    combinations.map((combination) => emitComposition(combination, ctx, depth)),
  );
}

export function typeExpression(schema: unknown, ctx: TypeContext): string {
  return expressionOf(schema, ctx).text;
}
