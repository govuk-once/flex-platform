import type { OperationConfig } from "@repo/gateway-config";
import { GatewayError } from "@repo/gateway-runtime";
import { isRecord } from "@repo/utils/is-record";
import { isScalar } from "@repo/utils/is-scalar";
import { ownValue } from "@repo/utils/own-value";

import type {
  OpenApiRestDriver,
  ParameterMapping,
} from "../config/definition.ts";
import { normaliseHeaderName } from "../headers.ts";
import { encodePathParam } from "../path.ts";
import type {
  OpenApiRestCall,
  OpenApiRestHandler,
  QueryValue,
} from "../types.ts";
import { METHODS_WITH_BODY, PAYLOAD_FIELD } from "../types.ts";
import { type ParsedUpstream, parseUpstream } from "../upstream.ts";

export type OpenApiRestOperationConfig = OperationConfig<OpenApiRestDriver>;

export interface CompiledOperation {
  readonly name: string;
  readonly upstream: ParsedUpstream;
  readonly handler: OpenApiRestHandler | undefined;
  // Maps the caller's input to a request. Throws on any input the operation does not account
  // for: a field that maps nowhere is a configuration bug, not something to drop silently.
  prepare(input: unknown): OpenApiRestCall;
}

function isQueryValue(value: unknown): value is QueryValue {
  if (isScalar(value)) return true;
  if (!Array.isArray(value)) return false;
  // A loop rather than `every`, which skips a sparse array's holes. A hole reads as undefined
  // and would reach the upstream as the string "undefined".
  for (const item of value) {
    if (!isScalar(item)) return false;
  }
  return true;
}

const LOCATIONS: ReadonlySet<string> = new Set(["path", "query", "header"]);

// The path as a plan: literals, and parameters already bound to the input field that supplies
// each one, so building a path looks nothing up.
type PathStep =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "param"; readonly name: string; readonly field: string };

interface Mappings {
  readonly steps: readonly PathStep[];
  // Query parameter -> input field.
  readonly query: ReadonlyMap<string, string>;
  // Lowercased header -> input field.
  readonly headers: ReadonlyMap<string, string>;
  // Every input field the operation accounts for. Fixed by the configuration, so a request
  // compares against it rather than recording what it consumed.
  readonly recognised: ReadonlySet<string>;
}

// Every template parameter must be declared, so the mapping reads completely against the input
// schema and a renamed field cannot be mistaken for an omission. Binding the steps here, where
// that is established, leaves a request with no absent case to handle.
function pathSteps(
  context: string,
  upstream: ParsedUpstream,
  // Path parameter -> input field.
  params: ReadonlyMap<string, string>,
): PathStep[] {
  const steps: PathStep[] = [];
  for (const part of upstream.parts) {
    if (part.kind === "literal") {
      steps.push({ kind: "literal", value: part.value });
      continue;
    }
    const field = params.get(part.name);
    if (field === undefined) {
      throw new TypeError(
        `${context}: path parameter "{${part.name}}" needs a parameters entry with in: "path"`,
      );
    }
    steps.push({ kind: "param", name: part.name, field });
  }
  return steps;
}

// The upstream name a field maps to, once the field and its mapping are ones a request can be
// built from.
function upstreamName(
  context: string,
  field: string,
  mapping: ParameterMapping,
): string {
  if (field.length === 0) {
    throw new TypeError(`${context}: parameter fields must be non-empty`);
  }
  if (field === PAYLOAD_FIELD) {
    throw new TypeError(
      `${context}: "${PAYLOAD_FIELD}" is the request body and cannot be a parameter`,
    );
  }
  if (mapping.name?.length === 0) {
    throw new TypeError(
      `${context}: parameter "${field}" has an empty upstream name`,
    );
  }
  // Not reachable from typed configuration; guards a JavaScript caller.
  if (!LOCATIONS.has(mapping.in)) {
    throw new TypeError(
      `${context}: parameter "${field}" has unknown location "${String(mapping.in)}"`,
    );
  }

  return mapping.name ?? field;
}

// One field per upstream name, so no request depends on which of two fields was read last.
function bindOnce(
  context: string,
  bindings: Map<string, string>,
  key: string,
  field: string,
  target: string,
): void {
  if (bindings.has(key)) {
    throw new TypeError(
      `${context}: ${target} is supplied by more than one field`,
    );
  }
  bindings.set(key, field);
}

function compileParameters(
  context: string,
  upstream: ParsedUpstream,
  parameters: Readonly<Record<string, ParameterMapping>> | undefined,
  reservedHeaders: ReadonlySet<string>,
): Mappings {
  const params = new Map<string, string>();
  const query = new Map<string, string>();
  const headers = new Map<string, string>();

  for (const [field, mapping] of Object.entries(parameters ?? {})) {
    const name = upstreamName(context, field, mapping);
    if (mapping.in === "path") {
      if (!upstream.params.includes(name)) {
        throw new TypeError(
          `${context}: parameter "${field}" names path parameter "{${name}}", which is not in the template`,
        );
      }

      bindOnce(context, params, name, field, `path parameter "{${name}}"`);
    } else if (mapping.in === "query") {
      bindOnce(context, query, name, field, `query parameter "${name}"`);
    } else {
      const header = normaliseHeaderName(
        name,
        `${context} parameter "${field}"`,
      );

      if (reservedHeaders.has(header)) {
        throw new TypeError(
          `${context}: parameter "${field}" maps to header "${name}", which is reserved by the driver`,
        );
      }

      bindOnce(context, headers, header, field, `header "${name}"`);
    }
  }

  return {
    steps: pathSteps(context, upstream, params),
    query,
    headers,
    recognised: new Set([
      ...params.values(),
      ...query.values(),
      ...headers.values(),
      PAYLOAD_FIELD,
    ]),
  };
}

// Reads an input field the caller set, never one it inherits.
type ReadField = (field: string) => unknown;

function buildPath(
  context: string,
  steps: readonly PathStep[],
  read: ReadField,
): string {
  let path = "";

  for (const step of steps) {
    if (step.kind === "literal") {
      path += step.value;
      continue;
    }

    const value = read(step.field);
    if (!isScalar(value)) {
      throw new GatewayError(
        "INTERNAL",
        `${context}: path parameter "${step.name}" needs a scalar input field "${step.field}"`,
      );
    }

    path += encodePathParam(
      String(value),
      `${context} path parameter "${step.name}"`,
    );
  }

  return path;
}

// Null-prototype dictionaries, here and for headers: an upstream name such as "__proto__" must
// become an own property, not an attempt to set the prototype that silently drops the value.
function queryValues(
  context: string,
  query: ReadonlyMap<string, string>,
  read: ReadField,
): Record<string, QueryValue> {
  const values = Object.create(null) as Record<string, QueryValue>;

  for (const [param, field] of query) {
    const value = read(field);
    if (value === undefined || value === null) continue;
    if (!isQueryValue(value)) {
      throw new GatewayError(
        "INTERNAL",
        `${context}: query parameter "${param}" needs a scalar or array of scalars in input field "${field}"`,
      );
    }
    values[param] = value;
  }

  return values;
}

function headerValues(
  context: string,
  headers: ReadonlyMap<string, string>,
  read: ReadField,
): Record<string, string> {
  const values = Object.create(null) as Record<string, string>;

  for (const [header, field] of headers) {
    const value = read(field);
    if (value === undefined || value === null) continue;
    if (!isScalar(value)) {
      throw new GatewayError(
        "INTERNAL",
        `${context}: header "${header}" needs a scalar input field "${field}"`,
      );
    }
    values[header] = String(value);
  }

  return values;
}

function bodyOf(
  context: string,
  method: ParsedUpstream["method"],
  read: ReadField,
): unknown {
  const body = read(PAYLOAD_FIELD);
  if (body !== undefined && !METHODS_WITH_BODY.has(method)) {
    throw new GatewayError(
      "INTERNAL",
      `${context}: ${method} requests cannot carry a "${PAYLOAD_FIELD}"`,
    );
  }

  return body;
}

// `reservedHeaders` holds lowercased names the driver keeps for itself, those its
// authentication sets; a mapping onto one is a configuration error, so mapped input can never
// replace what the driver sends there.
export function compileOperation(
  name: string,
  config: OpenApiRestOperationConfig,
  reservedHeaders: ReadonlySet<string> = new Set(),
): CompiledOperation {
  const context = `Operation "${name}"`;
  const upstream = parseUpstream(config.upstream);

  // Not reachable from typed configuration; guards a JavaScript caller.
  if (config.handler !== undefined && typeof config.handler !== "function") {
    throw new TypeError(`${context}: handler must be a function`);
  }
  const { steps, query, headers, recognised } = compileParameters(
    context,
    upstream,
    config.parameters,
    reservedHeaders,
  );

  function prepare(input: unknown): OpenApiRestCall {
    if (!isRecord(input)) {
      throw new GatewayError("INTERNAL", `${context}: input must be an object`);
    }
    // Own properties only: an omitted field named like an inherited member, `toString` say,
    // must read as absent rather than as Object.prototype's function.
    const read = (field: string): unknown => ownValue(input, field);

    const path = buildPath(context, steps, read);
    const queryParams = queryValues(context, query, read);
    const headerParams = headerValues(context, headers, read);
    const body = bodyOf(context, upstream.method, read);

    // Counted, never named: a schema that allows additional properties lets the caller choose
    // the names, and the message is logged.
    const unmapped = Object.keys(input).filter((key) => !recognised.has(key));
    if (unmapped.length > 0) {
      const fields = unmapped.length === 1 ? "field is" : "fields are";
      throw new GatewayError(
        "INTERNAL",
        `${context}: ${unmapped.length} input ${fields} not mapped to the upstream request`,
      );
    }

    return {
      method: upstream.method,
      path,
      ...(Object.keys(queryParams).length > 0 ? { query: queryParams } : {}),
      ...(Object.keys(headerParams).length > 0
        ? { headers: headerParams }
        : {}),
      ...(body !== undefined ? { body } : {}),
    };
  }

  return { name, upstream, handler: config.handler, prepare };
}
