import {
  assertGatewayId,
  type GatewaySchemas,
  type JSONSchema,
  SECURE_CLAIMS,
} from "@repo/gateway-core";
import { isRecord } from "@repo/utils/is-record";

import type { AnyGatewayConfig } from "./load-config.ts";

// Everything that must hold before anything is emitted. A configuration and its schemas are
// written separately, so they can disagree: an operation with no schemas, a schema for an
// operation that no longer exists, an input field the requests have nowhere to put. Each is a
// request that would fail in production, and each is visible here.

export class GatewayCheckError extends Error {
  readonly problems: readonly string[];

  constructor(gatewayId: string, problems: readonly string[]) {
    super(
      [
        `Gateway ${JSON.stringify(gatewayId)} configuration and schemas do not agree:`,
        ...problems.map((problem) => `  - ${problem}`),
      ].join("\n"),
    );
    this.name = "GatewayCheckError";
    this.problems = problems;
  }
}

const META_TYPES = ["string", "number", "integer", "boolean"];

// A promise is anything with a `then` function, so a client holding one would be awaited as one:
// returned from an async function, it would be called in place of the client being returned.
const RESERVED_OPERATIONS = new Set(["then"]);

// Whatever the gateway is called and generated from: its id, its operations' names and the module
// its schemas are derived by.
function identityProblems(config: AnyGatewayConfig): string[] {
  const problems: string[] = [];

  // The id names the gateway's function and its client package, and is written into generated
  // code, so it is checked here, before anything is written.
  try {
    assertGatewayId(config.id);
  } catch (error) {
    problems.push((error as Error).message);
  }

  for (const name of Object.keys(config.operations)) {
    if (RESERVED_OPERATIONS.has(name)) {
      problems.push(
        `an operation cannot be named ${JSON.stringify(name)}: its client would be taken for a promise`,
      );
    }
  }

  // Every driver derives its gateways' schemas, so no version is written by hand. The type
  // requires the module; an untyped configuration can leave it out, and would otherwise generate
  // from versions nothing can bring up to date. Only its URL is read here; the module is loaded
  // later, to check the latest version is still what it derives.
  const derive: unknown = config.driver.deriveSchemasModule;
  if (
    typeof derive !== "string" ||
    !URL.canParse(derive) ||
    new URL(derive).protocol !== "file:"
  ) {
    problems.push(
      `driver "${config.driver.type}" must give deriveSchemasModule, the file: URL of the module that derives its schemas`,
    );
  }

  return problems;
}

// The configuration's operations and the schemas' operations, each the other's.
function operationProblems(
  config: AnyGatewayConfig,
  schemas: GatewaySchemas,
): string[] {
  const problems: string[] = [];
  const configured = Object.keys(config.operations);

  if (configured.length === 0) {
    problems.push("the configuration declares no operations");
  }

  for (const name of configured) {
    if (!Object.hasOwn(schemas.operations, name)) {
      problems.push(`operation "${name}" has no schemas`);
      continue;
    }
    const opSchemas = schemas.operations[name];
    if (!isRecord(opSchemas?.input)) {
      problems.push(`operation "${name}" has no input schema`);
    }
    if (Object.keys(opSchemas?.outcomes ?? {}).length === 0) {
      problems.push(`operation "${name}" declares no outcomes`);
    }
  }

  for (const name of Object.keys(schemas.operations)) {
    if (!Object.hasOwn(config.operations, name)) {
      problems.push(
        `schemas declare operation "${name}", which the configuration does not`,
      );
    }
  }

  return problems;
}

// What is reported beside a result is a scalar under a name: a caller reads it without knowing
// its shape, and a log takes it whole, so it is never an object or a list.
function metaProblems(schemas: GatewaySchemas): string[] {
  return Object.entries(schemas.meta ?? {}).flatMap(([name, schema]) => {
    const type: unknown = schema.type;
    return typeof type === "string" && META_TYPES.includes(type)
      ? []
      : [
          `metadata "${name}" must declare one type, of ${META_TYPES.join(", ")}`,
        ];
  });
}

const CLAIMS: ReadonlySet<string> = new Set(SECURE_CLAIMS);

// The schema at a path of required properties, each a field the schema declares by name. Anything
// it can't place, a reference or a combinator among them, is no schema, so the binding is refused.
function requiredAt(
  schema: JSONSchema | undefined,
  segments: readonly string[],
): JSONSchema | undefined {
  let node = schema;
  for (const segment of segments) {
    const properties = node?.properties;
    const required = node?.required;
    if (
      !isRecord(properties) ||
      !Object.hasOwn(properties, segment) ||
      !Array.isArray(required) ||
      !required.includes(segment)
    ) {
      return undefined;
    }
    const next: unknown = properties[segment];
    if (!isRecord(next)) return undefined;
    node = next;
  }
  return node;
}

// A binding compares a field with a claim of the caller token, which is always a string. A field
// that may be absent, or isn't a string, would refuse every call that leaves it out or sends
// another type, so the configuration and its schema disagree.
function bindingProblems(
  config: AnyGatewayConfig,
  schemas: GatewaySchemas,
): string[] {
  const problems: string[] = [];
  for (const [name, operation] of Object.entries(config.operations)) {
    const input = Object.hasOwn(schemas.operations, name)
      ? schemas.operations[name]?.input
      : undefined;
    for (const [path, claim] of Object.entries(operation.secure ?? {})) {
      if (!CLAIMS.has(claim)) {
        problems.push(
          `operation "${name}" binds "${path}" to ${JSON.stringify(claim)}, which no caller token carries: ${SECURE_CLAIMS.join(", ")}`,
        );
        continue;
      }
      if (input === undefined) continue;
      if (requiredAt(input, path.split("."))?.type !== "string") {
        problems.push(
          `operation "${name}" binds "${path}", which its input schema doesn't declare as a required string`,
        );
      }
    }
  }
  return problems;
}

// What holds whatever the driver is. Relations between an operation's mappings and its schema
// are the driver's to read, and it reads them through checkSchemas.
function neutralProblems(
  config: AnyGatewayConfig,
  schemas: GatewaySchemas,
): readonly string[] {
  return [
    ...identityProblems(config),
    ...operationProblems(config, schemas),
    ...metaProblems(schemas),
    ...bindingProblems(config, schemas),
  ];
}

export function checkGateway(
  config: AnyGatewayConfig,
  schemas: GatewaySchemas,
): void {
  const problems = [...neutralProblems(config, schemas)];

  const fromDriver = config.driver.checkSchemas?.(config, schemas);
  if (fromDriver !== undefined) {
    if (!Array.isArray(fromDriver)) {
      throw new TypeError(
        `Driver "${config.driver.type}" checkSchemas must return an array of problems`,
      );
    }
    problems.push(...fromDriver.map(String));
  }

  if (problems.length > 0) {
    throw new GatewayCheckError(config.id, problems);
  }
}
