// Zod schemas as the document's JSON Schemas: an input as a request is validated, an output as a
// response is sent. A schema named with `.meta({ id })` moves from `$defs`, which would resolve
// against the document's root, to `components.schemas`, as two components, `<id>` and `<id>Input`,
// when its input and output differ, or when a named schema it refers to is two. A recursive schema
// must be named: Zod refers to an unnamed one as `#` or by an id it generates, neither of which a
// client can use.

import { isRecord } from "@repo/utils/is-record";
import type { ZodType } from "zod";
import { toJSONSchema } from "zod";

import type { JsonSchema, SchemaUse } from "./types.ts";

export const COMPONENTS_REF = "#/components/schemas/";

const DEFS_REF = "#/$defs/";

const COMPONENT_NAME = /^[a-zA-Z0-9._-]+$/;

// The id Zod generates for a recursive schema that has none of its own.
const GENERATED_ID = /^__schema\d+$/;

const NOT_DESCRIBABLE =
  "not describable as JSON Schema, use only what JSON carries, and no transform on a response";

const UNNAMED_RECURSION =
  "unnamed recursive schema, name it with .meta({ id })";

/** A schema as Zod describes it, without the named schemas it holds, which are under `defs`. */
export interface DescribedSchema {
  readonly use: SchemaUse;
  readonly at: string;
  readonly schema: JsonSchema;
  readonly defs: Readonly<Record<string, JsonSchema>>;
}

export interface DescribeOptions {
  readonly use: SchemaUse;
  readonly at: string;
}

export type DescribeResult =
  | { readonly ok: true; readonly described: DescribedSchema }
  | { readonly ok: false; readonly problem: string };

export type ComponentsResult =
  | {
      readonly ok: true;
      readonly schemas: Readonly<Record<string, JsonSchema>>;
      readonly resolve: (described: DescribedSchema) => JsonSchema;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

interface NamedSchema {
  readonly at: string;
  readonly json: string;
  readonly schema: JsonSchema;
}

type NamedById = Map<string, Map<SchemaUse, NamedSchema>>;

interface ComponentName {
  readonly id: string;
  readonly name: string;
  readonly at: string;
}

// A reserved name has no id.
interface TakenName {
  readonly id?: string;
  readonly by: string;
}

export function isJsonSchema(value: unknown): value is JsonSchema {
  return isRecord(value);
}

// The id a `#/$defs/<id>` reference names, or undefined for any other value.
function defIdOf(ref: unknown): string | undefined {
  return typeof ref === "string" && ref.startsWith(DEFS_REF)
    ? ref.slice(DEFS_REF.length)
    : undefined;
}

// `#` would mean the whole document once embedded.
function hasUnnamedRecursion(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnnamedRecursion);

  if (!isRecord(value)) return false;

  return Object.entries(value).some(([key, item]) =>
    key === "$ref"
      ? item === "#" || GENERATED_ID.test(defIdOf(item) ?? "")
      : hasUnnamedRecursion(item),
  );
}

// The ids of the named schemas a schema refers to.
function defIdsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(defIdsIn);

  if (!isRecord(value)) return [];

  return Object.entries(value).flatMap(([key, item]) => {
    if (key !== "$ref" || typeof item !== "string") return defIdsIn(item);

    const id = defIdOf(item);

    return id === undefined ? [] : [id];
  });
}

// Replaces each `#/$defs/<id>` reference with the component it moved to.
function refsToComponents(
  value: unknown,
  names: ReadonlyMap<string, string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => refsToComponents(item, names));
  }

  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key !== "$ref" || typeof item !== "string") {
        return [key, refsToComponents(item, names)];
      }

      const id = defIdOf(item);

      const name = id === undefined ? undefined : names.get(id);

      return [key, name === undefined ? item : `${COMPONENTS_REF}${name}`];
    }),
  );
}

function withComponentRefs(
  schema: JsonSchema,
  names: ReadonlyMap<string, string>,
): JsonSchema {
  const rewritten = refsToComponents(schema, names);

  return isJsonSchema(rewritten) ? rewritten : schema;
}

export function describeSchema(
  schema: ZodType,
  { use, at }: DescribeOptions,
): DescribeResult {
  let converted: JsonSchema;

  try {
    converted = toJSONSchema(schema, { io: use, cycles: "ref" });
  } catch {
    return { ok: false, problem: `${at}: ${NOT_DESCRIBABLE}` };
  }

  if (hasUnnamedRecursion(converted)) {
    return { ok: false, problem: `${at}: ${UNNAMED_RECURSION}` };
  }

  const { $defs = {}, ...described } = converted;

  // OpenAPI 3.1 sets the dialect for the whole document.
  Reflect.deleteProperty(described, "$schema");

  const defs = Object.fromEntries(
    Object.entries($defs).flatMap(([id, def]) =>
      isJsonSchema(def) ? [[id, def]] : [],
    ),
  );

  return { ok: true, described: { use, at, schema: described, defs } };
}

// Each named schema by its id, as each use describes it. One id naming two different schemas for
// one use is a problem.
function namedSchemasById(described: readonly DescribedSchema[]): {
  readonly namedById: NamedById;
  readonly problems: readonly string[];
} {
  const problems: string[] = [];

  const namedById: NamedById = new Map();

  for (const { use, at, defs } of described) {
    for (const [id, schema] of Object.entries(defs)) {
      const byUse = namedById.get(id) ?? new Map<SchemaUse, NamedSchema>();

      const json = JSON.stringify(schema);

      const first = byUse.get(use);

      if (first === undefined) {
        byUse.set(use, { at, json, schema });
      } else if (first.json !== json) {
        problems.push(
          `${at}: duplicate id ${JSON.stringify(id)}, also used by ${first.at}, give each schema its own id`,
        );
      }

      namedById.set(id, byUse);
    }
  }

  return { namedById, problems };
}

function differsByUse(byUse: ReadonlyMap<SchemaUse, NamedSchema>): boolean {
  const input = byUse.get("input");
  const output = byUse.get("output");

  return (
    input !== undefined && output !== undefined && input.json !== output.json
  );
}

// The ids named as two components. A schema whose JSON is the same both ways still splits when one
// it refers to does, or its one component would refer to whichever half was named last. The
// reference may be several deep, so pass again until a pass splits nothing more.
function splitIdsOf(namedById: NamedById): ReadonlySet<string> {
  const splitIds = new Set(
    [...namedById].flatMap(([id, byUse]) => (differsByUse(byUse) ? [id] : [])),
  );

  let canSplit = true;

  while (canSplit) {
    canSplit = false;

    for (const [id, byUse] of namedById) {
      const output = byUse.get("output");

      if (splitIds.has(id) || !byUse.has("input") || output === undefined) {
        continue;
      }

      if (defIdsIn(output.schema).some((ref) => splitIds.has(ref))) {
        splitIds.add(id);

        canSplit = true;
      }
    }
  }

  return splitIds;
}

// A component name holding a character it cannot, or one another id already has.
function componentNameProblems(
  { id, name, at }: ComponentName,
  taken: TakenName | undefined,
): string[] {
  const problems: string[] = [];

  if (!COMPONENT_NAME.test(name)) {
    problems.push(
      `${at}: invalid id ${JSON.stringify(id)}, must be letters, digits, ".", "_" and "-"`,
    );
  }

  if (taken !== undefined && taken.id !== id) {
    problems.push(
      `${at}: component name ${JSON.stringify(name)} already used by ${taken.by}, choose another id`,
    );
  }

  return problems;
}

/**
 * Names a component for each named schema the described schemas hold. `reserved` maps each
 * component name the document already uses to who uses it.
 */
export function nameComponents(
  described: readonly DescribedSchema[],
  reserved: ReadonlyMap<string, string> = new Map(),
): ComponentsResult {
  const { namedById, problems: duplicates } = namedSchemasById(described);

  const problems = [...duplicates];

  const splitIds = splitIdsOf(namedById);

  const names: Record<SchemaUse, Map<string, string>> = {
    input: new Map(),
    output: new Map(),
  };

  const takenNames = new Map<string, TakenName>(
    [...reserved].map(([name, by]) => [name, { by }]),
  );

  const entries: [string, SchemaUse, JsonSchema][] = [];

  for (const [id, byUse] of namedById) {
    const splits = splitIds.has(id);

    for (const [use, { at, schema }] of byUse) {
      const name = splits && use === "input" ? `${id}Input` : id;

      names[use].set(id, name);

      problems.push(
        ...componentNameProblems({ id, name, at }, takenNames.get(name)),
      );

      takenNames.set(name, { id, by: at });

      entries.push([name, use, schema]);
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    schemas: Object.fromEntries(
      entries.map(([name, use, schema]) => [
        name,
        withComponentRefs(schema, names[use]),
      ]),
    ),
    resolve: ({ use, schema }) => withComponentRefs(schema, names[use]),
  };
}
