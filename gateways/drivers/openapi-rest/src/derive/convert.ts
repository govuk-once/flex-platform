import { isRecord } from "@repo/utils/is-record";

// One schema of an upstream's OpenAPI document as a gateway holds it. The two sides of a call
// are converted differently, because they fail differently. An input is what a caller sends and
// the gateway vouches for, so it is held to everything the upstream says and closed to anything
// it does not: a field can be allowed later without breaking a caller, and never disallowed. An
// outcome is what an upstream sends, and an upstream moves on without asking: it adds a field,
// learns a new status, lets a name run longer. So an outcome is held to its shape, the types,
// the fields and which of them are required, and to nothing that a minor release upstream would
// turn into a failed response.

export type Side = "input" | "output";

// Where a definition is referred to from, gathered across every place this side refers to it.
// A definition is converted once and stands for every use, so it is converted for the strictest
// of them: one used inside a composition anywhere is converted as part of one everywhere.
export interface RefUse {
  composed: boolean;
  unionBranch: boolean;
  branchField: boolean;
  reversed: boolean;
}

export interface Conversion {
  readonly side: Side;
  // Where deriving departed from what the upstream wrote, for whoever reviews the result.
  readonly notes: Set<string>;
  // What it cannot represent at all. Reported together; any of them fails the run.
  readonly problems: string[];
  // The shared definitions this side refers to, by the upstream's name for each, with where.
  readonly refs: Map<string, RefUse>;
}

// A name an upstream wrote becomes a key here, and `__proto__` assigned to an object literal
// sets its prototype rather than becoming a property of it. The key would go missing, the checks
// that refuse that name would never see it, and whatever it held would answer for every lookup
// the object did not satisfy itself — `additionalProperties` among them, which is what closes an
// input. Defined rather than assigned, it is an ordinary property whatever it is called.
export function setKey(
  into: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(into, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

const SCHEMA_REF = /^#\/components\/schemas\/([^/]+)$/;

// What an OpenAPI document says about a schema that JSON Schema has no keyword for. The
// validators are built in strict mode, which refuses a keyword it does not know.
const NOT_JSON_SCHEMA: ReadonlySet<string> = new Set([
  "discriminator",
  "example",
  "examples",
  "externalDocs",
  "xml",
]);

// Constraints on a value rather than on its shape, which an outcome is not held to.
const VALUE_CONSTRAINTS: ReadonlySet<string> = new Set([
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "pattern",
  "uniqueItems",
]);

// The type a keyword applies to. Strict mode wants that type declared beside it, and refuses a
// keyword beside a type it says nothing about; upstream documents do both.
const APPLIES_TO: Readonly<Record<string, string>> = {
  additionalProperties: "object",
  dependentRequired: "object",
  dependentSchemas: "object",
  maxProperties: "object",
  minProperties: "object",
  patternProperties: "object",
  properties: "object",
  propertyNames: "object",
  required: "object",
  unevaluatedProperties: "object",
  contains: "array",
  items: "array",
  maxContains: "array",
  maxItems: "array",
  minContains: "array",
  minItems: "array",
  prefixItems: "array",
  unevaluatedItems: "array",
  uniqueItems: "array",
  maxLength: "string",
  minLength: "string",
  pattern: "string",
  exclusiveMaximum: "number",
  exclusiveMinimum: "number",
  maximum: "number",
  minimum: "number",
  multipleOf: "number",
};

// The bounds that count matches rather than measure a value. Every other bound left out is the
// loosest it could be, so removing one relaxes; `minContains` left out is one.
const CONTAINS_BOUNDS = ["maxContains", "minContains"];

const COMPOSITION = ["allOf", "anyOf", "oneOf"];
const SUBSCHEMA_MAPS = ["dependentSchemas", "patternProperties", "properties"];
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

// Whether a schema is one branch of a union, where a field with a single listed value is what
// tells the branches apart, and whether it is inside a composition at all, where closing an
// object would refuse the fields its sibling branches declare.
interface Position {
  readonly composed: boolean;
  readonly unionBranch: boolean;
  // A field of a union's branch. One with a single listed value is what tells that branch from
  // the others: opened, every branch would admit every tag and a caller could not tell them
  // apart, so it stays the one value it is.
  readonly branchField: boolean;
  // A place where admitting more admits less. Under a `not` the effect is turned around
  // outright; under a `oneOf` a branch that comes to admit more can take a value another already
  // admitted and leave two matching, which the whole then refuses; under an `if`, or a
  // `contains` a `maxContains` counts, what it decides is not what it admits. Every conversion
  // here moves what a schema admits one way on purpose — an input is closed so it admits less, an
  // outcome loses the constraints an upstream may relax so it admits more — and in such a place
  // each would do the opposite of what it is for. There the upstream's schema is kept as written.
  readonly reversed: boolean;
}

const TOP: Position = {
  composed: false,
  unionBranch: false,
  branchField: false,
  reversed: false,
};

// The keywords whose subschema is one of those places. A `oneOf` is one too, but only where
// nothing tells its branches apart; that is read from the branches themselves, below.
function reverses(
  key: string,
  schema: Readonly<Record<string, unknown>>,
): boolean {
  if (key === "not" || key === "if") return true;
  return key === "contains" && Object.hasOwn(schema, "maxContains");
}

// A schema that admits one scalar and no other, as text to tell it from another by. A scalar,
// because two objects that are the same value are not the same text — `{a:1,b:2}` and
// `{b:2,a:1}` — and a tag read as text would take those for two.
function singleValue(schema: unknown): string | undefined {
  if (!isRecord(schema)) return undefined;
  const [value, ...rest] = Object.hasOwn(schema, "const")
    ? [schema.const]
    : Array.isArray(schema.enum)
      ? (schema.enum as unknown[])
      : [];
  if (rest.length > 0 || value === undefined) return undefined;
  const kind = typeof value;
  return kind === "string" || kind === "number" || kind === "boolean"
    ? JSON.stringify(value)
    : undefined;
}

// Whether one field, required of every branch and fixed to a scalar of its own in each, is what
// tells a union's branches apart. Where one is, it goes on telling them apart whatever else in
// them is opened: a value carries one of those scalars, so it matches the one branch that names
// it and no other. Where none is — a branch written as a reference, whose fields are not here to
// read, a tag a branch may leave out, which a value omitting it would match in every branch, or
// branches that overlap in every field — a branch that came to admit more could take a value
// another already admitted, and a `oneOf` refuses what two of its branches match.
function taggedUnion(branches: readonly unknown[]): boolean {
  if (branches.length < 2) return false;
  const fixed = branches.map((branch) => {
    const found = new Map<string, string>();
    if (!isRecord(branch) || !admits(typesOf(branch), "object")) return found;
    const properties = branch.properties;
    if (!isRecord(properties)) return found;
    const required = new Set(
      Array.isArray(branch.required)
        ? branch.required.filter(
            (name): name is string => typeof name === "string",
          )
        : [],
    );
    for (const [name, schema] of Object.entries(properties)) {
      const value = singleValue(schema);
      if (value !== undefined && required.has(name)) found.set(name, value);
    }
    return found;
  });
  const [first] = fixed;
  if (first === undefined) return false;
  return [...first.keys()].some((name) => {
    const values = fixed.map((found) => found.get(name));
    return (
      values.every((value) => value !== undefined) &&
      new Set(values).size === values.length
    );
  });
}

const typesOf = (schema: Readonly<Record<string, unknown>>): string[] =>
  Array.isArray(schema.type)
    ? schema.type.filter((type): type is string => typeof type === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : [];

const admits = (types: readonly string[], type: string): boolean =>
  types.includes(type) || (type === "number" && types.includes("integer"));

export function convertSchema(
  schema: unknown,
  where: string,
  conversion: Conversion,
  position: Position = TOP,
): unknown {
  if (!isRecord(schema)) return schema;
  const { side, notes, problems } = conversion;
  const composed =
    position.composed || COMPOSITION.some((key) => Object.hasOwn(schema, key));
  let converted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (
      NOT_JSON_SCHEMA.has(key) ||
      key.startsWith("x-") ||
      key === "nullable"
    ) {
      continue;
    }
    // `nullable: true` beside a type is how OpenAPI 3.0 admits null, and is a type by now. Read
    // from the value rather than from the keyword being there, so `nullable: false` adds
    // nothing whichever order the two were written in, and with no type there is nothing for it
    // to add to: the schema admitted null already.
    if (key === "type") {
      const types = typesOf(schema);
      setKey(
        converted,
        "type",
        schema.nullable === true && types.length > 0
          ? [...new Set([...types, "null"])]
          : value,
      );
      continue;
    }

    const reversed = position.reversed || reverses(key, schema);
    if (key === "$ref") {
      const name =
        typeof value === "string" ? SCHEMA_REF.exec(value)?.[1] : undefined;
      if (name === undefined) {
        problems.push(
          `${where} refers to ${JSON.stringify(value)}; only a schema in the document's own components can be referred to`,
        );
        continue;
      }
      // Where it is used, not only that it is: a definition stands for every place it is named,
      // and is converted for the strictest of them.
      const use = conversion.refs.get(name) ?? {
        composed: false,
        unionBranch: false,
        branchField: false,
        reversed: false,
      };
      conversion.refs.set(name, {
        composed: use.composed || composed,
        unionBranch: use.unionBranch || position.unionBranch,
        branchField: use.branchField || position.branchField,
        reversed: use.reversed || position.reversed,
      });
      setKey(converted, "$ref", name);
    } else if (SUBSCHEMA_MAPS.includes(key) && isRecord(value)) {
      const held: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(value)) {
        setKey(
          held,
          name,
          convertSchema(member, `${where}.${key}.${name}`, conversion, {
            composed,
            unionBranch: false,
            branchField: key === "properties" && position.unionBranch,
            reversed,
          }),
        );
      }
      setKey(converted, key, held);
    } else if (SUBSCHEMAS.includes(key)) {
      setKey(
        converted,
        key,
        convertSchema(value, `${where}.${key}`, conversion, {
          composed,
          unionBranch: false,
          branchField: false,
          reversed,
        }),
      );
    } else if (COMPOSITION.includes(key) && Array.isArray(value)) {
      // A branch of an `anyOf` that comes to admit more makes the whole admit more, which is
      // the way every conversion here already runs. A branch of a `oneOf` does that only while
      // the branches stay apart, so one whose branches nothing tells apart is left as written.
      const branchReversed =
        position.reversed || (key === "oneOf" && !taggedUnion(value));
      setKey(
        converted,
        key,
        value.map((held, index) =>
          convertSchema(held, `${where}.${key}.${String(index)}`, conversion, {
            composed: true,
            unionBranch: key === "anyOf" || key === "oneOf",
            branchField: false,
            reversed: branchReversed,
          }),
        ),
      );
    } else if (key === "prefixItems" && Array.isArray(value)) {
      // The elements of a tuple, each a schema in its own right rather than another way of
      // saying what the whole is: an ordinary object among them is closed like any other.
      setKey(
        converted,
        key,
        value.map((held, index) =>
          convertSchema(held, `${where}.${key}.${String(index)}`, conversion, {
            composed,
            unionBranch: false,
            branchField: false,
            reversed,
          }),
        ),
      );
    } else {
      setKey(converted, key, value);
    }
  }

  if (side === "input" && converted.readOnly === true) {
    notes.add(
      `${where} is marked readOnly and is part of an input all the same`,
    );
  }
  if (side === "output" && converted.writeOnly === true) {
    notes.add(
      `${where} is marked writeOnly and is part of an outcome all the same`,
    );
  }

  converted = withType(
    converted,
    where,
    conversion,
    composed,
    position.reversed,
  );

  // Where admitting more admits less, the upstream's schema is what holds: every change below
  // moves what is admitted one way, and here each would move the whole the other.
  if (position.reversed) {
    notes.add(
      `${where} is somewhere a change in what it admits turns around, so it is held to exactly what the upstream wrote`,
    );
    return converted;
  }

  if (side === "output") {
    // Left out, `minContains` is one: a zero taken away is a bound arriving, not one going, and
    // an array with no match at all would pass the upstream and fail here. It stays, and
    // `maxContains` stays with it, since a validator refuses a zero with none beside it.
    const counted = converted.minContains === 0;
    if (counted) {
      notes.add(
        `${where} counts matches from none, which is not what counting from one would say, so both of its bounds are kept`,
      );
    }
    for (const key of Object.keys(converted)) {
      if (!VALUE_CONSTRAINTS.has(key)) continue;
      if (counted && CONTAINS_BOUNDS.includes(key)) continue;
      delete converted[key];
    }
    // Closed, an outcome would refuse a response for a field the upstream added.
    if (converted.additionalProperties === false) {
      delete converted.additionalProperties;
    }
    if (converted.unevaluatedProperties === false) {
      delete converted.unevaluatedProperties;
    }
    const tag =
      position.branchField &&
      Array.isArray(converted.enum) &&
      converted.enum.length === 1;
    return tag ? converted : withOpenValues(converted, where, conversion);
  }

  const isObject =
    admits(typesOf(converted), "object") || isRecord(converted.properties);
  if (
    isObject &&
    converted.$ref === undefined &&
    converted.additionalProperties === undefined &&
    converted.unevaluatedProperties === undefined
  ) {
    if (composed) {
      notes.add(
        `${where} is part of a composition, so it is left open: closing one part would refuse the fields the others declare`,
      );
    } else {
      converted.additionalProperties = false;
    }
  }
  return converted;
}

// The type a schema's keywords imply, where it declares none, and out with the keywords a
// declared type says nothing about. Either is a document the upstream's own tools accept.
function withType(
  schema: Record<string, unknown>,
  where: string,
  { notes, problems }: Conversion,
  composed: boolean,
  reversed: boolean,
): Record<string, unknown> {
  const implied = new Set(
    Object.keys(schema).flatMap((key) =>
      Object.hasOwn(APPLIES_TO, key) ? [APPLIES_TO[key] as string] : [],
    ),
  );
  const declared = typesOf(schema);

  if (declared.length > 0) {
    for (const key of Object.keys(schema)) {
      const applies = Object.hasOwn(APPLIES_TO, key)
        ? APPLIES_TO[key]
        : undefined;
      if (applies === undefined || admits(declared, applies)) continue;
      delete schema[key];
      notes.add(
        `${where} declares "${key}" beside type ${declared.join(" | ")}, which it says nothing about; it was dropped`,
      );
    }
    return schema;
  }

  const [only] = implied;
  if (implied.size !== 1 || only === undefined) return schema;
  // Beside a reference or inside a composition the type is for another part to declare.
  if (schema.$ref !== undefined || composed) return schema;
  // Giving a schema the type its keywords imply narrows it: `{ required: ["a"] }` says nothing
  // about a string and holds one no longer once it is an object. Somewhere that turns around,
  // that narrowing widens the whole, and a validator refuses the keyword without a type at all,
  // so there is nothing safe to write and the document is refused instead.
  if (reversed) {
    problems.push(
      `${where} declares no type beside keywords that need one, somewhere a change in what it admits turns around; write the type the upstream means`,
    );
    return schema;
  }
  notes.add(
    `${where} declares no type; its keywords are those of ${only === "object" || only === "array" ? "an" : "a"} ${only}, so it was given that type`,
  );
  return { type: only, ...schema };
}

const LISTABLE: ReadonlySet<string> = new Set(["integer", "number", "string"]);

function isOf(type: string, value: unknown): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "integer") return Number.isInteger(value);
  return typeof value === "number";
}

// The values an outcome lists become the values it knows of, beside the type that admits the
// rest: an upstream that comes to send another has not broken the contract, and a caller's
// types still name the ones there are.
function withOpenValues(
  schema: Record<string, unknown>,
  where: string,
  { notes }: Conversion,
): Record<string, unknown> {
  if (!Array.isArray(schema.enum)) return schema;
  const types = typesOf(schema);
  const base = types.filter((type) => type !== "null");
  const [only] = base;
  const values = schema.enum.filter((value) => value !== null);
  if (
    base.length !== 1 ||
    only === undefined ||
    !LISTABLE.has(only) ||
    schema.anyOf !== undefined ||
    !values.every((value) => isOf(only, value))
  ) {
    notes.add(
      `${where} lists values that are not all of one type it declares, so the list stays closed: a value the upstream adds will fail the response`,
    );
    return schema;
  }

  const opened: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "enum") continue;
    if (key !== "type") {
      setKey(opened, key, value);
      continue;
    }
    // A list whose only value is null knows no value of its type, and an empty `enum` is not a
    // schema Ajv will compile: what it knows of is left out rather than written as nothing.
    setKey(opened, "anyOf", [
      ...(values.length > 0 ? [{ enum: values }] : []),
      { type: only },
      ...(types.includes("null") ? [{ type: "null" }] : []),
    ]);
  }
  return opened;
}
