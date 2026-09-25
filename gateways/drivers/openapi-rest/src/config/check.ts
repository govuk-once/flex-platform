import type { GatewaySchemas, JSONSchema } from "@repo/gateway-types";
import { isRecord } from "@repo/utils/is-record";
import { ownValue } from "@repo/utils/own-value";
import { stringsIn } from "@repo/utils/strings-in";

import { normaliseHeaderName } from "../headers.ts";
import { metadataProblems } from "../metadata.ts";
import { METHODS_WITH_BODY, PAYLOAD_FIELD } from "../types.ts";
import { type ParsedUpstream, parseUpstream } from "../upstream.ts";
import type {
  OpenApiRestGatewayConfig,
  OpenApiRestOperationFields,
} from "./definition.ts";

// What a generated entry point cannot discover for itself: whether an operation's mappings and
// its input schema describe the same request. The runtime catches a mapping that contradicts
// the template when the executor is created, and an unmapped field when a request arrives; both
// are configuration errors, and both are visible here, before anything is emitted. Every finding
// is collected rather than thrown, so one run reports the whole picture.

// Follows "$ref": "<def>" through the shared definitions, which codegen registers under their
// keys, and answers with the schema the chain ends at. Where it ends short, because a
// definition is missing or because the chain comes back on itself, the last schema read is
// what there is to report a type from; collectFields is what classifies either as a problem.
function resolveSchema(
  schema: JSONSchema,
  defs: Readonly<Record<string, JSONSchema>>,
): JSONSchema {
  const following = new Set<string>();
  let current: JSONSchema = schema;
  while (typeof current.$ref === "string" && !following.has(current.$ref)) {
    following.add(current.$ref);
    const target = ownValue(defs, current.$ref);
    if (target === undefined) return current;
    current = target;
  }
  return current;
}

function intersect(sets: readonly Set<string>[]): Set<string> {
  const [first, ...rest] = sets;
  if (first === undefined) return new Set();
  return new Set(
    [...first].filter((name) => rest.every((other) => other.has(name))),
  );
}

// The fields an input can carry and the ones every valid input must, read through composition:
// a schema may declare them directly, in `allOf`, which all apply, or in `anyOf` and `oneOf`,
// where only a field every branch requires is guaranteed. Mappings are read against both, so a
// schema written with composition is not mistaken for one declaring nothing.
interface Fields {
  readonly names: Set<string>;
  readonly required: Set<string>;
  // A "$ref" no shared definition resolves, anywhere in the schema.
  unresolved: boolean;
  // A "$ref" back to a definition the chain to it is already following, which names no fields
  // of its own to read.
  cyclic: boolean;
}

// `following` holds the definitions on the way to this schema, not every definition seen. A
// reference to one of them is a cycle, and stops there; the same definition reached down two
// branches is read on each, because a branch is combined by where it sits: anyOf keeps only
// what every branch requires, so a branch that collected nothing would drop the lot.
function collectFields(
  schema: JSONSchema | undefined,
  defs: Readonly<Record<string, JSONSchema>>,
  following: ReadonlySet<string> = new Set(),
): Fields {
  const fields: Fields = {
    names: new Set(),
    required: new Set(),
    unresolved: false,
    cyclic: false,
  };
  if (schema === undefined) {
    fields.unresolved = true;
    return fields;
  }
  const absorb = (other: Fields, required: boolean): void => {
    for (const name of other.names) fields.names.add(name);
    if (required) for (const name of other.required) fields.required.add(name);
    if (other.unresolved) fields.unresolved = true;
    if (other.cyclic) fields.cyclic = true;
  };

  // A reference contributes what it declares, and in the 2020-12 dialect the keywords written
  // beside it still apply, so both are read.
  if (typeof schema.$ref === "string") {
    if (following.has(schema.$ref)) {
      fields.cyclic = true;
    } else {
      const target = ownValue(defs, schema.$ref);
      absorb(
        collectFields(target, defs, new Set([...following, schema.$ref])),
        true,
      );
    }
  }

  if (isRecord(schema.properties)) {
    for (const name of Object.keys(schema.properties)) fields.names.add(name);
  }
  // Anything but an array of strings names nothing. The direction is deliberate: a name not
  // read leaves a mapping reported, where reading `required: "id"` as the name "id" would
  // accept a path mapping the generated validator does not enforce, and the request that
  // arrives without it fails as INTERNAL. The schema itself is Ajv's to refuse, against the
  // meta-schema, when the validators are built.
  for (const name of stringsIn(schema.required)) fields.required.add(name);

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      absorb(collectFields(branch as JSONSchema, defs, following), true);
    }
  }

  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const collected = branches.map((branch) =>
      collectFields(branch as JSONSchema, defs, following),
    );
    for (const branch of collected) absorb(branch, false);
    // Only a field every branch requires is one every valid input carries.
    for (const name of intersect(collected.map((branch) => branch.required))) {
      fields.required.add(name);
    }
  }

  return fields;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Lowercased header names the gateway's authentication parts own, together. Malformed entries
// are the executor's to report; here they only mean no name is reserved.
function reservedHeaders(
  config: OpenApiRestGatewayConfig,
): ReadonlySet<string> {
  const parts: unknown = config.driver.auth;
  const names = new Set<string>();
  if (!Array.isArray(parts)) return names;
  for (const part of parts) {
    const declared: unknown = isRecord(part) ? part.headers : undefined;
    if (!Array.isArray(declared)) continue;
    for (const name of declared) {
      if (typeof name !== "string") continue;
      try {
        names.add(normaliseHeaderName(name, "Driver auth headers"));
      } catch {
        continue;
      }
    }
  }
  return names;
}

// An operation as the configuration holds it: the driver's own fields, and the handler the
// shared configuration adds, which decides whether the automatic mapping is used at all.
type CheckedOperation = OpenApiRestOperationFields & {
  readonly handler?: unknown;
};

function checkOperation(
  name: string,
  operation: CheckedOperation,
  input: JSONSchema,
  defs: Readonly<Record<string, JSONSchema>>,
  reserved: ReadonlySet<string>,
): readonly string[] {
  const context = `Operation "${name}"`;

  let upstream: ParsedUpstream;
  try {
    upstream = parseUpstream(operation.upstream);
  } catch (error: unknown) {
    return [`${context}: ${messageOf(error)}`];
  }

  // Read from the schema as written: a reference's own keywords are followed from there, and
  // the ones beside it are part of the same shape.
  const declared = collectFields(input, defs);
  if (declared.unresolved) {
    return [
      `${context}: input schema has a "$ref" that no shared definition resolves`,
    ];
  }
  if (declared.cyclic) {
    return [
      `${context}: input schema has a "$ref" that refers back to a definition it is reached from, so it declares no fields`,
    ];
  }

  // What the schema says itself, or what the definition it references says.
  const stated = input.type ?? resolveSchema(input, defs).type;
  if (stated !== undefined && stated !== "object") {
    return [
      `${context}: input schema must describe an object, so every field maps to part of the request`,
    ];
  }

  const problems: string[] = [];
  const fields = [...declared.names];
  const required = declared.required;

  // A custom handler builds its own request: the executor hands it the input and the client and
  // never calls the automatic mapping, so what that mapping would need of the schema is not a
  // requirement here. What the executor compiles for every operation, handler or not — the
  // template's parameters, the names a mapping may take, the headers it may not set — is read
  // below either way. A handler that does call `prepare` is left to the runtime, which fails
  // the request as INTERNAL: nothing here can tell which kind of handler it is.
  const automatic = operation.handler === undefined;

  const mapped = new Set<string>();
  // The upstream names already spoken for, by location. Two fields on one name means the
  // request sends whichever the executor compiled last, so it refuses to compile at all; that
  // is a cold start away from the deployment, and the configuration says it here.
  const filled = new Set<string>();
  const queries = new Set<string>();
  const headers = new Set<string>();

  for (const [field, mapping] of Object.entries(operation.parameters ?? {})) {
    // Counted as accounted for before anything is read of it: a field the configuration tried
    // to map is not also one that reaches no part of the request.
    mapped.add(field);
    // What the executor refuses outright when it compiles the operation, said at build time
    // rather than at the first cold start after a deployment. Nothing further is read of the
    // entry, because there is no field for the schema to declare.
    if (field.length === 0) {
      problems.push(`${context}: parameter fields must be non-empty`);
      continue;
    }
    if (field === PAYLOAD_FIELD) {
      problems.push(
        `${context}: "${PAYLOAD_FIELD}" is the request body and cannot be a parameter`,
      );
      continue;
    }
    // Only the automatic mapping reads the operation's input: a handler calls `prepare` with an
    // object it builds, so the fields a mapping names are the handler's to supply and need not
    // be declared in the schema at all.
    if (automatic && !declared.names.has(field)) {
      problems.push(
        `${context}: parameter "${field}" has no field of that name in the input schema`,
      );
    }
    // An empty upstream name reaches no parameter and no header. Reading further would record
    // it as a name of its own, and report a second field renamed onto the same nothing.
    if (mapping.name !== undefined && mapping.name.length === 0) {
      problems.push(
        `${context}: parameter "${field}" has an empty upstream name`,
      );
      continue;
    }
    const upstreamName = mapping.name ?? field;

    if (mapping.in === "path") {
      if (!upstream.params.includes(upstreamName)) {
        problems.push(
          `${context}: parameter "${field}" names path parameter "{${upstreamName}}", which the template "${upstream.template}" does not declare`,
        );
        continue;
      }
      if (filled.has(upstreamName)) {
        problems.push(
          `${context}: path parameter "{${upstreamName}}" is supplied by more than one field`,
        );
      }
      filled.add(upstreamName);
      // A path is built from every segment, so an absent value has no request to send. The
      // executor would raise INTERNAL per request; the schema can refuse it per caller instead.
      if (automatic && !required.has(field)) {
        problems.push(
          `${context}: path parameter "{${upstreamName}}" is filled by input field "${field}", which the input schema does not require`,
        );
      }
    } else if (mapping.in === "header") {
      try {
        const header = normaliseHeaderName(
          upstreamName,
          `${context} parameter "${field}"`,
        );
        if (reserved.has(header)) {
          problems.push(
            `${context}: parameter "${field}" maps to header "${upstreamName}", which the gateway's authentication owns`,
          );
        }
        // Compared as the executor holds them: header names differing only in case are one name.
        if (headers.has(header)) {
          problems.push(
            `${context}: header "${upstreamName}" is supplied by more than one field`,
          );
        }
        headers.add(header);
      } catch (error: unknown) {
        problems.push(messageOf(error));
      }
    } else if (mapping.in === "query") {
      if (queries.has(upstreamName)) {
        problems.push(
          `${context}: query parameter "${upstreamName}" is supplied by more than one field`,
        );
      }
      queries.add(upstreamName);
    } else {
      // Not reachable from typed configuration; guards a JavaScript caller, and says what the
      // executor refuses rather than reading an unknown location as a query parameter.
      problems.push(
        `${context}: parameter "${field}" has unknown location "${String(mapping.in)}"`,
      );
    }
  }

  for (const param of upstream.params) {
    if (!filled.has(param)) {
      problems.push(
        `${context}: path parameter "{${param}}" has no parameters entry with in: "path" that names it`,
      );
    }
  }

  if (automatic) {
    for (const field of fields) {
      if (field === PAYLOAD_FIELD || mapped.has(field)) continue;
      problems.push(
        `${context}: input field "${field}" is not mapped to the upstream request; give it a parameters entry or carry it in "${PAYLOAD_FIELD}"`,
      );
    }
  }

  if (
    automatic &&
    declared.names.has(PAYLOAD_FIELD) &&
    !METHODS_WITH_BODY.has(upstream.method)
  ) {
    problems.push(
      `${context}: the input schema declares "${PAYLOAD_FIELD}", which a ${upstream.method} request cannot carry`,
    );
  }

  return problems;
}

// The one type a schema names, if it names one. The configuration's schema for a header says
// what its text is read as, and the stored one what that is held to. Codegen holds every stored
// one to a single scalar type of its own, so one written any other way is reported there and
// not twice.
function typeNamed(schema: unknown): string | undefined {
  return isRecord(schema) && typeof schema.type === "string"
    ? schema.type
    : undefined;
}

// What the gateway reports beside a result is declared twice: the schemas say what a caller is
// offered, and the driver says which header each is read from. A name only one of them knows is
// either offered and never reported, or reported and thrown away.
function metadataAgreement(
  config: OpenApiRestGatewayConfig,
  schemas: GatewaySchemas,
): readonly string[] {
  const metadata: unknown = config.driver.metadata;
  const problems = [...metadataProblems(metadata)];
  const mapped = isRecord(metadata) ? Object.keys(metadata) : [];
  const stored = schemas.meta ?? {};
  const declared = Object.keys(stored);
  for (const name of declared) {
    if (!mapped.includes(name)) {
      problems.push(
        `metadata "${name}" is in the schemas, and the driver's metadata names no header to read it from`,
      );
    }
  }
  for (const name of mapped) {
    if (!declared.includes(name)) {
      problems.push(
        `metadata "${name}" is read from a header, and the schemas do not declare it`,
      );
      continue;
    }
    // A header is text, and the configured schema decides what it is read as: a count, a flag,
    // or the text itself. The stored schema is what validates the result, so one that does not
    // admit what the other produces drops every value the upstream sends, silently, since what
    // fails validation is left out rather than reported.
    const entry = ownValue(metadata as Record<string, unknown>, name);
    const reads = typeNamed(isRecord(entry) ? entry.schema : undefined);
    const holds = typeNamed(ownValue(stored, name));
    if (reads === undefined || holds === undefined) continue;
    // Every integer is a number, so one held to numbers is held to what is read.
    if (holds !== reads && !(reads === "integer" && holds === "number")) {
      problems.push(
        `metadata "${name}" is read from its header as ${reads}, and the schemas hold it to ${holds}; what is read would not validate`,
      );
    }
  }
  return problems;
}

// Reads each operation's mappings against its input schema. Operations without schemas are
// left alone: codegen reports those itself, and repeating it here would say it twice.
export function checkOperationSchemas(
  config: OpenApiRestGatewayConfig,
  schemas: GatewaySchemas,
): readonly string[] {
  const defs = schemas.defs ?? {};
  const reserved = reservedHeaders(config);
  const problems: string[] = [...metadataAgreement(config, schemas)];

  for (const [name, operation] of Object.entries(config.operations)) {
    if (!Object.hasOwn(schemas.operations, name)) continue;
    const opSchemas = schemas.operations[name];
    if (opSchemas === undefined) continue;
    problems.push(
      ...checkOperation(name, operation, opSchemas.input, defs, reserved),
    );
  }

  return problems;
}
