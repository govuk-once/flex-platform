import type { ExecutorOptions } from "@repo/gateway-config";
import { GatewayError, UPSTREAM_TARGET_ENV } from "@repo/gateway-runtime";
import type { ExecuteFn } from "@repo/gateway-types";
import { isRecord } from "@repo/utils/is-record";

import type {
  OpenApiRestAuth,
  OpenApiRestAuthInstance,
} from "../config/auth.ts";
import type { OpenApiRestGatewayConfig } from "../config/definition.ts";
import { isSecretField } from "../config/secret-field.ts";
import { normaliseHeaderName, validateHeaders } from "../headers.ts";
import { compileMetadata } from "../metadata.ts";
import { OPENAPI_REST_DRIVER_TYPE } from "../types.ts";
import { createAuthTransport } from "./auth-transport.ts";
import { type AuthHeaders, type ClientDeps, createClient } from "./client.ts";
import { requestFailure } from "./failure.ts";
import { type CompiledOperation, compileOperation } from "./operation.ts";
import { secretFields } from "./secret.ts";
import { parseUpstreamTarget } from "./target.ts";

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

// Not reachable from typed configuration; guards a JavaScript caller.
function checkAuthParts(
  gatewayId: string,
  auth: unknown,
): readonly OpenApiRestAuth[] {
  if (!Array.isArray(auth)) {
    throw new TypeError(
      `Gateway "${gatewayId}" driver auth must be a list of authentication parts, [] for none`,
    );
  }
  return auth.map((part: unknown, index) => {
    const candidate = part as Partial<OpenApiRestAuth> | null | undefined;
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      typeof candidate.create !== "function" ||
      !Array.isArray(candidate.headers) ||
      !candidate.headers.every((name) => typeof name === "string") ||
      !Array.isArray(candidate.fields) ||
      !candidate.fields.every(isSecretField)
    ) {
      throw new TypeError(
        `Gateway "${gatewayId}" driver auth part ${String(index)} must be a definition with headers, fields and create`,
      );
    }
    return candidate as OpenApiRestAuth;
  });
}

// The headers each part owns, lowercased. No two parts may own one: whichever ran second would
// replace what the first set, and a signature over the first's value would no longer match.
function ownedHeaders(
  parts: readonly OpenApiRestAuth[],
): readonly ReadonlySet<string>[] {
  const claimed = new Set<string>();
  return parts.map((part) => {
    const owned = new Set(
      part.headers.map((name) =>
        normaliseHeaderName(name, "Driver auth headers"),
      ),
    );
    for (const name of owned) {
      if (claimed.has(name)) {
        throw new TypeError(
          `Driver auth: header "${name}" is owned by more than one part`,
        );
      }
      claimed.add(name);
    }
    return owned;
  });
}

function isAuthInstance(value: unknown): value is OpenApiRestAuthInstance {
  return (
    isRecord(value) &&
    typeof (value as Partial<OpenApiRestAuthInstance>).headers === "function"
  );
}

interface AuthStep {
  readonly instance: OpenApiRestAuthInstance;
  readonly owned: ReadonlySet<string>;
}

// Each part in order, shown the request with what the parts before it set, so a signature covers
// a key. An authentication flow fails with its own error, or a library's, which can carry the
// request it was making or the secret it read in its message, its properties, its cause or its
// name. The runtime logs all of those, so nothing of the error survives unless the flow raised a
// GatewayError, which is its declaration that the message is safe.
function authHeadersFor(steps: readonly AuthStep[]): AuthHeaders {
  return async (request) => {
    const { operation } = request;
    const added = new Headers();
    for (const { instance, owned } of steps) {
      // A copy of the address and the headers for each part, so one part cannot change what a
      // later one sees: a signature over an address the transport does not send is refused.
      const url = new URL(request.url.href);
      const headers = new Headers(request.headers);
      for (const [name, value] of added) headers.set(name, value);
      let provided: unknown;
      try {
        provided = await instance.headers({ ...request, url, headers });
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
      const set = validateHeaders(
        provided as Readonly<Record<string, string>>,
        `Operation "${operation}" authentication`,
        requestFailure,
      );
      for (const [name, value] of set) {
        if (!owned.has(name)) {
          throw new GatewayError(
            "INTERNAL",
            `Operation "${operation}": authentication set header "${name}", which its definition does not declare`,
          );
        }
        added.set(name, value);
      }
    }
    return added;
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
  const parts = checkAuthParts(config.id, config.driver.auth);
  const owned = ownedHeaders(parts);
  const reservedHeaders = new Set(owned.flatMap((names) => [...names]));
  const targetField: unknown = config.driver.target;
  if (targetField !== undefined && !isSecretField(targetField)) {
    throw new TypeError(
      `Gateway "${config.id}" driver target must name the secret field that holds it, with fromSecret`,
    );
  }
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

  // With no field of the secret naming the upstream, UPSTREAM_TARGET is the only place it can
  // come from, and it is checked with the rest of the configuration, before the secret is read.
  const noUpstream = () =>
    new TypeError(
      `Gateway "${config.id}" has no upstream: set ${UPSTREAM_TARGET_ENV}, or name the secret field that holds it as the driver's target`,
    );
  const fromEnvironment =
    options.target === undefined
      ? undefined
      : parseUpstreamTarget(options.target);
  if (targetField === undefined && fromEnvironment === undefined) {
    throw noUpstream();
  }

  const operations = new Map<string, CompiledOperation>();
  for (const [name, opConfig] of Object.entries(config.operations)) {
    operations.set(name, compileOperation(name, opConfig, reservedHeaders));
  }

  // Configuration is checked; now the deployment is. The initial secret is retrieved and every
  // field the configuration names is checked, and the authentication state built on it, before
  // there is an executor: a missing or invalid secret fails here, never on a request.
  const secret = secretFields(config.id, options.secret, [
    ...(targetField === undefined ? [] : [targetField]),
    ...parts.flatMap((part) => part.fields),
  ]);
  const initial = await secret.get();

  // A target the secret names is used in place of UPSTREAM_TARGET, so the environment variable
  // and the secret can each be set without the other. Read once, here: an address that moves
  // takes effect when the executor is next created.
  const fromSecret =
    targetField === undefined ? undefined : initial.get(targetField);
  const target =
    fromSecret !== undefined && targetField !== undefined
      ? parseUpstreamTarget(
          fromSecret,
          `Secret field "${targetField.secretField}"`,
        )
      : fromEnvironment;
  if (target === undefined) throw noUpstream();

  const transport = createAuthTransport({
    fetch: deps.fetch,
    target,
    maxResponseBytes,
  });
  const steps = parts.map((part, index): AuthStep => {
    const instance: unknown = part.create({ secret, transport });
    if (!isAuthInstance(instance)) {
      throw new TypeError(
        `Gateway "${config.id}" driver auth part ${String(index)} create() must return an instance with a headers function`,
      );
    }
    return { instance, owned: owned[index] ?? new Set() };
  });

  const clientDeps: ClientDeps = {
    target,
    fetch: deps.fetch,
    staticHeaders,
    auth: authHeadersFor(steps),
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
