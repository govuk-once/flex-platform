import type { ExecutorOptions } from "@repo/gateway-config";
import { GatewayError } from "@repo/gateway-runtime";
import type { ExecuteFn } from "@repo/gateway-types";
import { isRecord } from "@repo/utils/is-record";

import type {
  OpenApiRestAuth,
  OpenApiRestAuthInstance,
} from "../config/auth.ts";
import type { OpenApiRestGatewayConfig } from "../config/definition.ts";
import { normaliseHeaderName, validateHeaders } from "../headers.ts";
import { compileMetadata } from "../metadata.ts";
import { OPENAPI_REST_DRIVER_TYPE } from "../types.ts";
import { createAuthTransport } from "./auth-transport.ts";
import { type AuthHeaders, type ClientDeps, createClient } from "./client.ts";
import { requestFailure } from "./failure.ts";
import { type CompiledOperation, compileOperation } from "./operation.ts";
import { validatedSecret } from "./secret.ts";
import { parseUpstreamTarget } from "./target.ts";

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

// Not reachable from typed configuration; guards a JavaScript caller.
function checkAuthDefinition(
  gatewayId: string,
  auth: unknown,
): OpenApiRestAuth {
  const candidate = auth as Partial<OpenApiRestAuth> | null | undefined;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof candidate.validateSecret !== "function" ||
    typeof candidate.create !== "function" ||
    !Array.isArray(candidate.headers) ||
    !candidate.headers.every((name) => typeof name === "string")
  ) {
    throw new TypeError(
      `Gateway "${gatewayId}" driver auth must be a definition with validateSecret, headers and create`,
    );
  }
  return candidate as OpenApiRestAuth;
}

function isAuthInstance(value: unknown): value is OpenApiRestAuthInstance {
  return (
    isRecord(value) &&
    typeof (value as Partial<OpenApiRestAuthInstance>).headers === "function"
  );
}

// An authentication flow fails with its own error, or a library's, which can carry the request
// it was making or the secret it read in its message, its properties, its cause or its name.
// The runtime logs all of those, so nothing of the error survives unless the flow raised a
// GatewayError, which is its declaration that the message is safe.
function authHeadersFor(
  instance: OpenApiRestAuthInstance,
  declared: ReadonlySet<string>,
): AuthHeaders {
  return async (operation, signal) => {
    let provided: unknown;
    try {
      provided = await instance.headers({ operation, signal });
    } catch (err: unknown) {
      if (err instanceof GatewayError) throw err;
      throw new GatewayError(
        "INTERNAL",
        `Authentication failed for operation "${operation}"`,
      );
    }
    if (!isRecord(provided)) {
      throw new GatewayError(
        "INTERNAL",
        `Authentication must return a record of header values for operation "${operation}"`,
      );
    }
    const headers = validateHeaders(
      provided as Readonly<Record<string, string>>,
      `Operation "${operation}" authentication`,
      requestFailure,
    );
    for (const name of headers.keys()) {
      if (!declared.has(name)) {
        throw new GatewayError(
          "INTERNAL",
          `Operation "${operation}": authentication set header "${name}", which its definition does not declare`,
        );
      }
    }
    return headers;
  };
}

// Test seam: the executor with an injected fetch. Not part of the public surface;
// createExecutor is what an entrypoint calls.
export interface BuildDeps {
  readonly fetch: typeof fetch;
}

export async function buildExecutor(
  config: OpenApiRestGatewayConfig,
  options: ExecutorOptions,
  deps: BuildDeps,
): Promise<ExecuteFn> {
  const driverType: string = config.driver.type;
  if (driverType !== OPENAPI_REST_DRIVER_TYPE) {
    throw new TypeError(
      `Gateway "${config.id}" driver type must be "${OPENAPI_REST_DRIVER_TYPE}", got "${driverType}"`,
    );
  }

  const maxResponseBytes =
    config.driver.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError("Driver maxResponseBytes must be a positive integer");
  }

  // The headers authentication owns are reserved before anything else is compiled: neither
  // the driver's static headers, an operation's mappings nor a handler's call may set them, so
  // mapped input cannot replace what the gateway authenticates with.
  const auth = checkAuthDefinition(config.id, config.driver.auth);
  const reservedHeaders = new Set(
    auth.headers.map((name) =>
      normaliseHeaderName(name, "Driver auth headers"),
    ),
  );
  const staticHeaders = validateHeaders(
    config.driver.headers ?? {},
    "Driver headers",
  );
  for (const name of staticHeaders.keys()) {
    if (reservedHeaders.has(name)) {
      throw new TypeError(
        `Driver headers: header "${name}" is reserved by the driver's authentication and cannot be set`,
      );
    }
  }

  const metadata = compileMetadata(config.driver.metadata);

  const target = parseUpstreamTarget(options.target);

  const operations = new Map<string, CompiledOperation>();
  for (const [name, opConfig] of Object.entries(config.operations)) {
    operations.set(name, compileOperation(name, opConfig, reservedHeaders));
  }

  // Configuration is checked; now the deployment is. The initial secret is retrieved and
  // validated, and the authentication state built on it, before there is an executor: a
  // missing or invalid secret fails here, never on a request.
  const secret = validatedSecret(
    config.id,
    options.secret,
    auth.validateSecret,
  );
  await secret.get();
  const instance: unknown = auth.create({
    secret,
    transport: createAuthTransport({
      fetch: deps.fetch,
      target,
      maxResponseBytes,
    }),
  });
  if (!isAuthInstance(instance)) {
    throw new TypeError(
      `Gateway "${config.id}" driver auth create() must return an instance with a headers function`,
    );
  }

  const clientDeps: ClientDeps = {
    target,
    fetch: deps.fetch,
    staticHeaders,
    auth: authHeadersFor(instance, reservedHeaders),
    reservedHeaders,
    maxResponseBytes,
    metadata,
  };

  return async (ctx, operation, input) => {
    const op = operations.get(operation);
    if (op === undefined) {
      throw new GatewayError("INTERNAL", `Unknown operation "${operation}"`);
    }
    const client = createClient(ctx, op, clientDeps);
    if (op.handler !== undefined) {
      // The runtime validated `input` against the schema the handler's declared input type
      // describes; the handler type's `never` input only says any declared type is accepted.
      return op.handler(input as never, client);
    }
    return client.invoke(client.prepare(input));
  };
}

// Builds the execute function for createHandler from a gateway configuration and the neutral
// options an entrypoint supplies. Every operation is compiled and the secret retrieved and
// validated here, so configuration and deployment problems fail at startup, not per request.
export function createExecutor(
  config: OpenApiRestGatewayConfig,
  options: ExecutorOptions,
): Promise<ExecuteFn> {
  return buildExecutor(config, options, { fetch: globalThis.fetch });
}
