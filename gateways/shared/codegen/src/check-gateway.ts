import type { GatewaySchemas } from "@repo/gateway-types";
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
        `Gateway "${gatewayId}" configuration and schemas do not agree:`,
        ...problems.map((problem) => `  - ${problem}`),
      ].join("\n"),
    );
    this.name = "GatewayCheckError";
    this.problems = problems;
  }
}

const META_TYPES = ["string", "number", "integer", "boolean"];

// What holds whatever the driver is. Relations between an operation's mappings and its schema
// are the driver's to read, and it reads them through checkSchemas.
function neutralProblems(
  config: AnyGatewayConfig,
  schemas: GatewaySchemas,
): readonly string[] {
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

  // What is reported beside a result is a scalar under a name: a caller reads it without
  // knowing its shape, and a log takes it whole, so it is never an object or a list.
  for (const [name, schema] of Object.entries(schemas.meta ?? {})) {
    const type: unknown = schema.type;
    if (typeof type !== "string" || !META_TYPES.includes(type)) {
      problems.push(
        `metadata "${name}" must declare one type, of ${META_TYPES.join(", ")}`,
      );
    }
  }

  return problems;
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
