import type { OperationConfig } from "@repo/gateway-config";
import { GatewayError } from "@repo/gateway-runtime";
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
  // Indexed rather than `every`, which skips a sparse array's holes. A hole reads as undefined
  // and would reach the upstream as the string "undefined".
  for (let index = 0; index < value.length; index += 1) {
    if (!isScalar(value[index])) return false;
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
    if (field.length === 0) {
      throw new TypeError(`${context}: parameter fields must be non-empty`);
    }
    if (field === PAYLOAD_FIELD) {
      throw new TypeError(
        `${context}: "${PAYLOAD_FIELD}" is the request body and cannot be a parameter`,
      );
    }
    if (mapping.name !== undefined && mapping.name.length === 0) {
      throw new TypeError(
        `${context}: parameter "${field}" has an empty upstream name`,
      );
    }
    const name = mapping.name ?? field;

    // Not reachable from typed configuration; guards a JavaScript caller.
    if (!LOCATIONS.has(mapping.in)) {
      throw new TypeError(
        `${context}: parameter "${field}" has unknown location "${String(mapping.in)}"`,
      );
    }
    if (mapping.in === "path") {
      if (!upstream.params.includes(name)) {
        throw new TypeError(
          `${context}: parameter "${field}" names path parameter "{${name}}", which is not in the template`,
        );
      }
      if (params.has(name)) {
        throw new TypeError(
          `${context}: path parameter "{${name}}" is supplied by more than one field`,
        );
      }
      params.set(name, field);
    } else if (mapping.in === "query") {
      if (query.has(name)) {
        throw new TypeError(
          `${context}: query parameter "${name}" is supplied by more than one field`,
        );
      }
      query.set(name, field);
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
      if (headers.has(header)) {
        throw new TypeError(
          `${context}: header "${name}" is supplied by more than one field`,
        );
      }
      headers.set(header, field);
    }
  }

  // Every template parameter must be declared, so the mapping reads completely against the
  // input schema and a renamed field cannot be mistaken for an omission. Binding the steps
  // here, where that is established, leaves a request with no absent case to handle.
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

  return {
    steps,
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

  const acceptsBody = METHODS_WITH_BODY.has(upstream.method);

  function prepare(input: unknown): OpenApiRestCall {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new GatewayError("INTERNAL", `${context}: input must be an object`);
    }
    const fields = input as Record<string, unknown>;
    // Own properties only: an omitted field named like an inherited member, `toString` say,
    // must read as absent rather than as Object.prototype's function.
    const read = (field: string): unknown => ownValue(fields, field);

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

    // Null-prototype dictionaries: an upstream name such as "__proto__" must become an own
    // property, not an attempt to set the prototype that silently drops the value.
    const queryValues = Object.create(null) as Record<string, QueryValue>;
    for (const [param, field] of query) {
      const value = read(field);
      if (value === undefined || value === null) continue;
      if (!isQueryValue(value)) {
        throw new GatewayError(
          "INTERNAL",
          `${context}: query parameter "${param}" needs a scalar or array of scalars in input field "${field}"`,
        );
      }
      queryValues[param] = value;
    }

    const headerValues = Object.create(null) as Record<string, string>;
    for (const [header, field] of headers) {
      const value = read(field);
      if (value === undefined || value === null) continue;
      if (!isScalar(value)) {
        throw new GatewayError(
          "INTERNAL",
          `${context}: header "${header}" needs a scalar input field "${field}"`,
        );
      }
      headerValues[header] = String(value);
    }

    let body: unknown;
    if (Object.hasOwn(fields, PAYLOAD_FIELD)) {
      body = fields[PAYLOAD_FIELD];
      if (body !== undefined && !acceptsBody) {
        throw new GatewayError(
          "INTERNAL",
          `${context}: ${upstream.method} requests cannot carry a "${PAYLOAD_FIELD}"`,
        );
      }
    }

    // Counted, never named: a schema that allows additional properties lets the caller choose
    // the names, and the message is logged.
    const unmapped = Object.keys(fields).filter((key) => !recognised.has(key));
    if (unmapped.length > 0) {
      throw new GatewayError(
        "INTERNAL",
        `${context}: ${unmapped.length} input ${unmapped.length === 1 ? "field is" : "fields are"} not mapped to the upstream request`,
      );
    }

    return {
      method: upstream.method,
      path,
      ...(Object.keys(queryValues).length > 0 ? { query: queryValues } : {}),
      ...(Object.keys(headerValues).length > 0
        ? { headers: headerValues }
        : {}),
      ...(body !== undefined ? { body } : {}),
    };
  }

  return { name, upstream, handler: config.handler, prepare };
}
