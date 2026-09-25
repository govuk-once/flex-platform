import { isDeepStrictEqual } from "node:util";

import type { DeriveSchemas } from "@repo/gateway-config";
import type { JSONSchema, OperationSchemas } from "@repo/gateway-types";
import { isRecord } from "@repo/utils/is-record";
import { sortedNames } from "@repo/utils/sorted-names";

import type { ParameterMapping } from "../config/definition.ts";
import { normaliseHeaderName } from "../headers.ts";
import { outcomeForStatus } from "../outcomes.ts";
import { PAYLOAD_FIELD } from "../types.ts";
import { parseUpstream } from "../upstream.ts";
import {
  type Conversion,
  convertSchema,
  eachSubschema,
  mapSubschemas,
  setKey,
  type Side,
} from "./convert.ts";
import {
  loadDocument,
  OpenApiDeriveError,
  type OpenApiDocument,
  resolved,
} from "./document.ts";

// A gateway's schemas from its upstream's OpenAPI document, for the operations its configuration
// declares and no others. The configuration says which request each operation is and which of
// its input fields fills which parameter; the document says what each parameter, body and
// response holds. Nothing here reaches the network except through what it is given, and nothing
// outside this directory imports it: the driver's definition names it, so the parser it needs
// never becomes part of a deployed gateway.

type Schema = Record<string, unknown>;

const JSON_CONTENT = /^application\/(?:[\w.-]+\+)?json(?:$|;)/i;
const PLAIN_JSON = /^application\/json(?:$|;)/i;

// The schema under a media type the driver reads or writes. A response is parsed as JSON
// whatever its type says, so any of the `+json` family will do for one. A request is sent as
// `application/json` and nothing else, so a body offered only under another type is one this
// cannot ask for: `application/merge-patch+json` derived and then sent as `application/json` is
// a different request from the one the document describes.
function jsonSchemaOf(content: unknown, exact = false): unknown {
  if (!isRecord(content)) return undefined;
  const matches = exact ? PLAIN_JSON : JSON_CONTENT;
  const [, media] =
    Object.entries(content).find(([type]) => PLAIN_JSON.test(type)) ??
    Object.entries(content).find(([type]) => matches.test(type)) ??
    [];
  return isRecord(media) ? media.schema : undefined;
}

// What the driver writes in each place. A path or a header carries one scalar, written as
// itself; a query carries one scalar, or an array of them repeated under the name.
const SCALARS: ReadonlySet<string> = new Set([
  "boolean",
  "integer",
  "null",
  "number",
  "string",
]);

// Every value a converted schema admits, in the terms the driver has to write. Read from what
// the conversion produced rather than from the document: that is what the validators are
// generated from, and a second reading of the document would say something else about the same
// parameter — `{ "type": "string", "additionalProperties": false }` is a string once the
// keyword the type says nothing about has gone.
//
// A schema that constrains nothing admits every value, which is not nothing: it has to be
// carried through a union, where one such branch admits what the others exclude, and through an
// array's tail, where `prefixItems` without `items` says nothing of the elements past the ones
// it names. `anything` is that, under a name no type has.
const ANYTHING = "anything";

interface Admits {
  readonly types: Set<string>;
  readonly elements: Set<string>;
  // Whether an array it admits may have nothing in it. The driver writes a query array by
  // repeating the name once per element, so one with no elements writes no name at all.
  readonly empty: boolean;
  recursive: boolean;
}

const admitsNothing = (): Admits => ({
  types: new Set(),
  elements: new Set(),
  empty: false,
  recursive: false,
});

// Every value, which is every element too: a schema that constrains nothing constrains nothing
// about what an array holds either. An empty element domain would be the opposite — no element
// at all — and would take another part's restriction with it where the two are intersected, and
// add nothing where they are united.
const admitsAnything = (): Admits => ({
  types: new Set([ANYTHING]),
  elements: new Set([ANYTHING]),
  empty: true,
  recursive: false,
});

// The types two parts both admit, for an `allOf` where each holds at once. Anything admits every
// type, so it takes the other's; every integer is a number, so a part taking numbers takes
// another's integers.
function both(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  if (a.has(ANYTHING)) return new Set(b);
  if (b.has(ANYTHING)) return new Set(a);
  const kept = new Set<string>();
  for (const type of a) {
    if (b.has(type)) kept.add(type);
    else if (type === "integer" && b.has("number")) kept.add("integer");
    else if (type === "number" && b.has("integer")) kept.add("integer");
  }
  return kept;
}

// A part says something about elements only where it could be an array: a branch admitting null
// beside one admitting an array of strings says nothing of elements, and taking its silence for
// a restriction, or for the absence of one, would read the union wrong either way.
const mayBeArray = (part: Admits): boolean =>
  part.types.has("array") || part.types.has(ANYTHING);

// Parts that all hold at once, or one of which holds. The elements follow the same rule as the
// types: an array whose elements nothing describes admits every element, so beside one that
// admits strings a union admits every element and an `allOf` admits strings.
function merged(parts: readonly Admits[], how: "all" | "any"): Admits {
  const all = how === "all";
  let types = all ? new Set([ANYTHING]) : new Set<string>();
  let elements = all ? new Set([ANYTHING]) : new Set<string>();
  // An empty array is a value like any other: every part has to admit it for an `allOf` to,
  // and one branch admitting it is enough for a union.
  let empty = all;
  let recursive = false;
  for (const part of parts) {
    types = all ? both(types, part.types) : new Set([...types, ...part.types]);
    if (mayBeArray(part)) {
      elements = all
        ? both(elements, part.elements)
        : new Set([...elements, ...part.elements]);
      empty = all ? empty && part.empty : empty || part.empty;
    }
    if (part.recursive) recursive = true;
  }
  return { types, elements, empty, recursive };
}

// Whether an array this schema describes may have nothing in it. `minItems` says so outright;
// `contains` wants a match among the elements, which nothing can supply where there are none,
// unless `minContains: 0` says the schema will do without one.
function mayBeEmpty(schema: Readonly<Record<string, unknown>>): boolean {
  const least: unknown = schema.minItems;
  if (typeof least === "number" && least >= 1) return false;
  if (Object.hasOwn(schema, "contains")) {
    const wanted: unknown = schema.minContains;
    if (typeof wanted !== "number" || wanted >= 1) return false;
  }
  return true;
}

// What a schema says its elements are. `items` describes every element `prefixItems` did not
// name; left out, the elements past those are described by nothing at all, and so is every
// element of an array that names none. `items: false` is a tuple saying it ends, and describes
// no element because there is none.
function elementsOf(
  schema: Readonly<Record<string, unknown>>,
  prefix: readonly unknown[],
  defs: ReadonlyMap<string, unknown>,
  seen: ReadonlySet<string>,
): Admits {
  const elements = new Set<string>();
  let recursive = false;
  const read = (held: unknown): void => {
    const inner = admittedBy(held, defs, seen);
    for (const type of inner.types) elements.add(type);
    if (inner.recursive) recursive = true;
  };
  for (const held of prefix) read(held);
  if (Object.hasOwn(schema, "items")) read(schema.items);
  else elements.add(ANYTHING);
  return {
    types: new Set([ANYTHING]),
    elements,
    empty: mayBeEmpty(schema),
    recursive,
  };
}

function admittedBy(
  schema: unknown,
  defs: ReadonlyMap<string, unknown>,
  seen: ReadonlySet<string> = new Set(),
): Admits {
  // `false` admits no value, which is how a tuple says it ends; `true`, and anything else that
  // is not a schema object, admits every value.
  if (schema === false) return admitsNothing();
  if (!isRecord(schema)) return admitsAnything();

  // Every part of the schema holds at once: what it names of itself, what a definition it
  // refers to names, each part of an `allOf`, and one branch of each union.
  const parts: Admits[] = [];

  if (typeof schema.$ref === "string") {
    const name = schema.$ref;
    if (seen.has(name)) {
      const found = admitsAnything();
      found.recursive = true;
      parts.push(found);
    } else {
      parts.push(admittedBy(defs.get(name), defs, new Set([...seen, name])));
    }
  }

  const branchesOf = (key: string): unknown[] => {
    const held: unknown = schema[key];
    return Array.isArray(held) ? (held as unknown[]) : [];
  };

  const named = Array.isArray(schema.type)
    ? schema.type.filter((type): type is string => typeof type === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : [];
  const own = elementsOf(schema, branchesOf("prefixItems"), defs, seen);
  // What it says of itself: the types it names, or every type where it names none, which is
  // what leaves the rest of the parts to say.
  parts.push({
    types: named.length > 0 ? new Set(named) : new Set([ANYTHING]),
    elements: own.elements,
    empty: own.empty,
    recursive: own.recursive,
  });

  for (const branch of branchesOf("allOf")) {
    parts.push(admittedBy(branch, defs, seen));
  }
  for (const key of ["anyOf", "oneOf"]) {
    const branches = branchesOf(key);
    if (branches.length > 0) {
      parts.push(
        merged(
          branches.map((branch) => admittedBy(branch, defs, seen)),
          "any",
        ),
      );
    }
  }

  return merged(parts, "all");
}

// What a parameter a gateway sends has to be. A path and a header carry one scalar and a query
// a scalar or a repeated name, so anything else would go out as a different request from the one
// described, and is refused rather than derived and sent wrong.
interface ParameterCheck {
  readonly declared: Declared;
  readonly where: string;
  // The parameter's schema as it was converted, which is what the validators hold it to.
  readonly schema: unknown;
}

function parameterProblems(
  { declared, where, schema }: ParameterCheck,
  defs: ReadonlyMap<string, unknown>,
): string[] {
  const { in: location, name, parameter } = declared;
  const what = `${location} parameter "${name}" of ${where}`;
  const problems: string[] = [];
  const { style, explode } = parameter;

  if (parameter.allowReserved === true) {
    problems.push(
      `${what} asks for reserved characters to go unencoded, and the driver encodes them`,
    );
  }

  const { types, elements, empty, recursive } = admittedBy(schema, defs);
  if (recursive) {
    problems.push(
      `${what} refers to itself, and the driver has one scalar to send there`,
    );
  }
  if (types.has(ANYTHING)) {
    problems.push(
      `${what} admits a value of any type, so what the driver would have to send cannot be read`,
    );
  }
  const unsupported = sortedNames(
    [...types].filter(
      (type) =>
        type !== ANYTHING &&
        !SCALARS.has(type) &&
        !(location === "query" && type === "array"),
    ),
  );
  if (unsupported.length > 0) {
    problems.push(
      `${what} is ${unsupported.join(" or ")}, and the driver sends ${location === "query" ? "a scalar or an array of them" : "one scalar"} there`,
    );
  }
  // A required parameter has to be written, and null is not something the driver writes: in a
  // path it is not a value at all, and elsewhere it is how a caller leaves a parameter out,
  // which a required one may not be.
  if (declared.required && types.has("null")) {
    problems.push(
      `${what} is required and admits null, which the driver does not send: null leaves a parameter out`,
    );
  }

  if (location === "query" && types.has("array")) {
    // The elements reach the upstream one by one, each written as itself. An array that says
    // nothing of them says nothing this can hold them to.
    if (elements.has(ANYTHING)) {
      problems.push(
        `${what} is an array whose elements are not all described, so what the driver would have to send cannot be read`,
      );
    }
    const badElements = sortedNames(
      [...elements].filter(
        (type) => type !== ANYTHING && (!SCALARS.has(type) || type === "null"),
      ),
    );
    if (badElements.length > 0) {
      problems.push(
        `${what} is an array of ${badElements.join(" or ")}, and the driver writes each element as one scalar`,
      );
    }
    // The name is written once per element, so an array with no elements writes nothing and the
    // upstream sees a request without the parameter: the same absence null would leave, past a
    // validator that admitted the value.
    if (declared.required && empty) {
      problems.push(
        `${what} is required and admits an array with nothing in it, which the driver does not send: an empty array leaves a parameter out`,
      );
    }
  }

  if (location === "query") {
    if (style !== undefined && style !== "form") {
      problems.push(
        `${what} is serialised as ${JSON.stringify(style)}, and the driver writes a query as "form"`,
      );
    }
    if (types.has("array") && explode === false) {
      problems.push(
        `${what} is an array written without exploding, and the driver repeats the name for each element`,
      );
    }
  } else if (style !== undefined && style !== "simple") {
    problems.push(
      `${what} is serialised as ${JSON.stringify(style)}, and the driver writes a ${location} parameter as "simple"`,
    );
  }

  return problems;
}

const sameParameter = (
  location: string,
  name: string,
  other: { readonly in: string; readonly name: string },
): boolean =>
  location === other.in &&
  (location === "header"
    ? name.toLowerCase() === other.name.toLowerCase()
    : name === other.name);

interface Declared {
  readonly in: string;
  readonly name: string;
  readonly required: boolean;
  readonly parameter: Readonly<Record<string, unknown>>;
}

// The parameters an operation takes: the path's, with the operation's own in place of any it
// declares again.
function parametersOf(
  document: OpenApiDocument,
  pathItem: Readonly<Record<string, unknown>>,
  operation: Readonly<Record<string, unknown>>,
  where: string,
  problems: string[],
): Declared[] {
  const declared: Declared[] = [];
  for (const list of [pathItem.parameters, operation.parameters]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const parameter = resolved(
        document,
        entry,
        `${where} parameter`,
        problems,
      );
      if (parameter === undefined) continue;
      const { in: location, name } = parameter;
      if (typeof location !== "string" || typeof name !== "string") continue;
      const existing = declared.findIndex((other) =>
        sameParameter(location, name, other),
      );
      const next: Declared = {
        in: location,
        name,
        required: parameter.required === true || location === "path",
        parameter,
      };
      if (existing < 0) declared.push(next);
      else declared[existing] = next;
    }
  }
  return declared;
}

function describedBy(
  schema: unknown,
  parameter: Readonly<Record<string, unknown>>,
): unknown {
  if (!isRecord(schema)) return schema;
  return {
    ...schema,
    ...(schema.description === undefined &&
    typeof parameter.description === "string"
      ? { description: parameter.description }
      : {}),
    ...(schema.deprecated === undefined && parameter.deprecated === true
      ? { deprecated: true }
      : {}),
  };
}

interface Sides {
  readonly input: Conversion;
  readonly output: Conversion;
}

function deriveOperation(
  name: string,
  configured: Readonly<Record<string, unknown>>,
  document: OpenApiDocument,
  sides: Sides,
  checks: ParameterCheck[],
): OperationSchemas | undefined {
  const { problems, notes } = sides.input;
  if (typeof configured.upstream !== "string") {
    problems.push(`operation "${name}" names no upstream request`);
    return undefined;
  }
  let upstream;
  try {
    upstream = parseUpstream(configured.upstream);
  } catch (error) {
    problems.push(
      `operation "${name}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }

  const where = `${upstream.method} ${upstream.template}`;
  const paths = document.paths;
  const pathItem =
    isRecord(paths) && Object.hasOwn(paths, upstream.template)
      ? resolved(document, paths[upstream.template], where, problems)
      : undefined;
  const operation =
    pathItem === undefined
      ? undefined
      : pathItem[upstream.method.toLowerCase()];
  if (pathItem === undefined || !isRecord(operation)) {
    problems.push(
      `operation "${name}" is ${where}, which the document does not describe`,
    );
    return undefined;
  }

  // ---- the input: one field for each parameter the configuration maps, and the body
  const mappings = isRecord(configured.parameters) ? configured.parameters : {};
  const declared = parametersOf(document, pathItem, operation, where, problems);
  const properties: Schema = {};
  const required: string[] = [];
  const taken = new Set<Declared>();

  for (const [field, mapping] of Object.entries(mappings)) {
    if (!isRecord(mapping) || typeof mapping.in !== "string") continue;
    const { in: location, name: mapped } =
      mapping as unknown as ParameterMapping;
    const target = mapped ?? field;
    const parameter = declared.find((other) =>
      sameParameter(
        location,
        location === "header" ? safeHeader(target) : target,
        other,
      ),
    );
    if (parameter === undefined) {
      problems.push(
        `operation "${name}" sends field "${field}" as ${location} parameter "${target}", which ${where} does not declare`,
      );
      continue;
    }
    taken.add(parameter);
    if (parameter.parameter.schema === undefined) {
      problems.push(
        `${where} describes ${location} parameter "${parameter.name}" by its content rather than a schema, which is not supported`,
      );
      continue;
    }
    const converted = convertSchema(
      describedBy(parameter.parameter.schema, parameter.parameter),
      `${where} ${location} parameter "${parameter.name}"`,
      sides.input,
    );
    // Held against what the driver can send once the definitions it names are converted too,
    // which is after every operation has been read.
    checks.push({ declared: parameter, where, schema: converted });
    setKey(properties, field, converted);
    if (parameter.required) required.push(field);
  }

  for (const parameter of declared) {
    if (taken.has(parameter)) continue;
    const what = `${parameter.in} parameter "${parameter.name}" of ${where}`;
    if (parameter.in === "cookie" && !parameter.required) {
      notes.add(`${what} is a cookie, which a gateway does not send`);
    } else if (parameter.in === "cookie") {
      // A gateway sends no cookies, so a required one is a request it cannot make.
      problems.push(`${what} is a required cookie, and a gateway sends none`);
    } else if (parameter.required) {
      problems.push(
        `${what} is required, and operation "${name}" maps no input field to it`,
      );
    } else {
      notes.add(
        `${what} is optional and operation "${name}" maps no input field to it, so callers cannot send it`,
      );
    }
  }

  const body =
    operation.requestBody === undefined
      ? undefined
      : resolved(
          document,
          operation.requestBody,
          `${where} request body`,
          problems,
        );
  if (body !== undefined) {
    const schema = jsonSchemaOf(body.content, true);
    if (schema === undefined) {
      problems.push(
        `${where} takes a request body the driver cannot send: it is offered under ${offered(body.content)} and the driver sends application/json`,
      );
    } else {
      setKey(
        properties,
        PAYLOAD_FIELD,
        convertSchema(schema, `${where} request body`, sides.input),
      );
      // Whatever the document says: a body an operation declares is one its upstream expects,
      // and a generator that leaves `required` out has not said otherwise.
      required.push(PAYLOAD_FIELD);
    }
  }

  // ---- the outcomes: each status the upstream answers a request it carried out with
  const outcomes: Record<string, JSONSchema> = {};
  const responses = isRecord(operation.responses) ? operation.responses : {};
  for (const [status, entry] of Object.entries(responses)) {
    const outcome = outcomeForStatus(Number(status));
    if (outcome === undefined) {
      if (/^2/.test(status)) {
        notes.add(
          `${where} answers ${status}, which the driver maps to no outcome; a response with it fails`,
        );
      }
      continue;
    }
    const response = resolved(
      document,
      entry,
      `${where} response ${status}`,
      problems,
    );
    if (response === undefined) continue;
    const schema = jsonSchemaOf(response.content);
    if (status === "204" || response.content === undefined) {
      if (status === "204" && schema !== undefined) {
        notes.add(
          `${where} describes a body for its 204, which has none; it was left out`,
        );
      }
      outcomes[outcome] = { type: "null" };
    } else if (schema === undefined) {
      problems.push(`${where} answers ${status} with a body that is not JSON`);
    } else {
      outcomes[outcome] = convertSchema(
        schema,
        `${where} response ${status}`,
        sides.output,
      ) as JSONSchema;
    }
  }
  if (Object.keys(outcomes).length === 0) {
    problems.push(
      `${where} describes no response the driver maps to an outcome (200, 201, 202 or 204)`,
    );
  }

  return {
    input: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    outcomes,
  };
}

// What a body is offered under, for saying why none of it can be sent.
function offered(content: unknown): string {
  const types = isRecord(content) ? Object.keys(content) : [];
  return types.length === 0
    ? "no media type"
    : types.map((type) => JSON.stringify(type)).join(", ");
}

// A header's name as the driver compares them, or as written where it is not one the driver
// would accept; the configuration's own check reports that.
function safeHeader(name: string): string {
  try {
    return normaliseHeaderName(name, "parameter");
  } catch {
    return name;
  }
}

// The shared definitions each side refers to, converted for that side, with whatever they refer
// to in turn.
function definitionsFor(
  document: OpenApiDocument,
  conversion: Conversion,
): Map<string, unknown> {
  const components = document.components;
  const schemas =
    isRecord(components) && isRecord(components.schemas)
      ? components.schemas
      : {};
  const converted = new Map<string, unknown>();
  // What each was converted for, so one whose uses grow is converted again: a definition first
  // met on its own and later inside a composition must not stay closed against the fields its
  // siblings declare, and one later met as a branch of a union must keep what tells it from the
  // others. Uses only ever grow, so this settles.
  const convertedFor = new Map<string, string>();

  for (let more = true; more;) {
    more = false;
    for (const [name, use] of [...conversion.refs]) {
      const at = JSON.stringify(use);
      if (convertedFor.get(name) === at) continue;
      convertedFor.set(name, at);
      more = true;
      if (!Object.hasOwn(schemas, name)) {
        conversion.problems.push(
          `the document refers to schema "${name}", which its components do not hold`,
        );
        converted.set(name, {});
        continue;
      }
      converted.set(
        name,
        convertSchema(
          schemas[name],
          `components.schemas.${name}`,
          conversion,
          use,
        ),
      );
    }
  }
  return converted;
}

// The names a schema refers to, read through the positions a schema can be in. A "$ref" is one
// only where a schema is; anywhere else it is a key of a value the caller has to send.
function refsIn(schema: unknown, found = new Set<string>()): Set<string> {
  if (!isRecord(schema)) return found;
  if (typeof schema.$ref === "string") found.add(schema.$ref);
  eachSubschema(schema, (held) => {
    refsIn(held, found);
  });
  return found;
}

// A definition used on both sides of a call is converted twice and kept under two names, so the
// references to it are rewritten to whichever name the side being written uses. Only the
// references: a `const` or an `enum` holding an object of its own keeps every key it was
// written with, whatever those keys are called.
function renamingRefs(
  schema: unknown,
  renamed: ReadonlyMap<string, string>,
): unknown {
  if (!isRecord(schema)) return schema;
  const result = mapSubschemas(schema, (held) => renamingRefs(held, renamed));
  if (typeof result.$ref === "string") {
    setKey(result, "$ref", renamed.get(result.$ref) ?? result.$ref);
  }
  return result;
}

const INPUT_SUFFIX = "Input";

const derive: DeriveSchemas = async (config, sources) => {
  const location = (config.driver as { readonly spec?: unknown }).spec;
  if (typeof location !== "string" || location === "") {
    throw new OpenApiDeriveError("the configuration", [
      "the driver names no OpenAPI document as its `spec`",
    ]);
  }
  const document = await loadDocument(location, sources);

  const notes = new Set<string>();
  const problems: string[] = [];
  const side = (which: Side): Conversion => ({
    side: which,
    notes,
    problems,
    refs: new Map(),
  });
  const sides: Sides = { input: side("input"), output: side("output") };

  const operations: Record<string, OperationSchemas> = {};
  const checks: ParameterCheck[] = [];
  for (const [name, configured] of Object.entries(config.operations)) {
    const derived = deriveOperation(name, configured, document, sides, checks);
    if (derived !== undefined) operations[name] = derived;
  }

  const inputs = definitionsFor(document, sides.input);
  const outputs = definitionsFor(document, sides.output);

  // Now that a name a parameter uses leads somewhere, what each one admits can be read the way
  // the validators read it.
  for (const check of checks)
    problems.push(...parameterProblems(check, inputs));

  // A definition both sides use is one definition where both hold it the same way. Where they
  // do not, an object the input closes and the outcome leaves open, the input takes a name of
  // its own, and so does whatever refers to it from that side.
  const apart = new Set(
    [...inputs.keys()].filter(
      (name) =>
        outputs.has(name) &&
        !isDeepStrictEqual(inputs.get(name), outputs.get(name)),
    ),
  );
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, schema] of inputs) {
      if (apart.has(name) || !outputs.has(name)) continue;
      if ([...refsIn(schema)].some((ref) => apart.has(ref))) {
        apart.add(name);
        grew = true;
      }
    }
  }
  const renamed = new Map(
    [...apart].map((name) => [name, `${name}${INPUT_SUFFIX}`]),
  );
  for (const [name, inputName] of renamed) {
    if (inputs.has(inputName) || outputs.has(inputName)) {
      problems.push(
        `schema "${name}" is held differently as an input, which needs the name "${inputName}" the document already uses`,
      );
    }
    notes.add(
      `schema "${name}" is used by an input and an outcome, which hold it differently; the input's is "${inputName}"`,
    );
  }

  // A definition converted again as its uses grew says the same thing twice.
  if (problems.length > 0) {
    throw new OpenApiDeriveError(location, [...new Set(problems)]);
  }

  // In the order the document declares them, an input's own beside the one it parted from.
  const components = document.components;
  const declaredOrder = Object.keys(
    isRecord(components) && isRecord(components.schemas)
      ? components.schemas
      : {},
  );
  const defs: Record<string, JSONSchema> = {};
  for (const name of declaredOrder) {
    if (outputs.has(name)) setKey(defs, name, outputs.get(name));
    else if (inputs.has(name) && !apart.has(name)) {
      setKey(defs, name, renamingRefs(inputs.get(name), renamed));
    }
    if (apart.has(name)) {
      setKey(
        defs,
        `${name}${INPUT_SUFFIX}`,
        renamingRefs(inputs.get(name), renamed),
      );
    }
  }
  for (const operation of Object.values(operations)) {
    operation.input = renamingRefs(operation.input, renamed) as JSONSchema;
  }

  return {
    schemas: {
      ...(Object.keys(defs).length > 0 ? { defs } : {}),
      operations,
    },
    notes: [...notes],
  };
};

export default derive;
