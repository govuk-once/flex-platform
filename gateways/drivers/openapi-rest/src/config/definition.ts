import type {
  AnyOperations,
  DriverDefinition,
  ExecutorOptions,
  GatewayConfig,
} from "@repo/gateway-config";

import {
  type HttpMethod,
  OPENAPI_REST_DRIVER_TYPE,
  type OpenApiRestHandler,
} from "../types.ts";
import type { OpenApiRestAuth } from "./auth.ts";
import { checkOperationSchemas } from "./check.ts";

// Behaviour lives here, reviewed with the gateway. Deployment values such as the target and
// the secret arrive as executor options instead.
export interface OpenApiRestDriverConfig {
  // Location of the OpenAPI document describing the upstream. Recorded so the contract can be
  // reviewed alongside the gateway; nothing fetches it at runtime.
  readonly spec: string;
  // Static headers sent on every request, such as an API version.
  readonly headers?: Readonly<Record<string, string>>;
  // Largest response body the driver buffers, in bytes. Defaults to 1 MiB.
  readonly maxResponseBytes?: number;
  // How requests are authenticated: bearerToken(), apiKey() or noAuth() from this package, or
  // a definition written with defineAuth. It says what the secret must hold and which headers
  // it owns. Required, so a gateway that sends no credential says so.
  readonly auth: OpenApiRestAuth;
}

export type UpstreamTemplate = `${HttpMethod} /${string}`;

// Where one input field goes, in the OpenAPI document's own vocabulary. `name` is the upstream
// parameter or header when it differs from the input field.
export interface ParameterMapping {
  readonly in: "path" | "query" | "header";
  readonly name?: string;
}

// The caller's input is one flat object and does not know how it maps to HTTP. The operation
// declares that per field: a path parameter, a query parameter or a header. Every path
// parameter in the template needs an entry. The request body, when there is one, travels under
// the top-level `payload` field.
export type OpenApiRestOperationFields = {
  readonly upstream: UpstreamTemplate;
  readonly parameters?: Readonly<Record<string, ParameterMapping>>;
};

export interface OpenApiRestDriver
  extends
    DriverDefinition<OpenApiRestOperationFields, OpenApiRestHandler>,
    OpenApiRestDriverConfig {
  readonly type: typeof OPENAPI_REST_DRIVER_TYPE;
}

export type OpenApiRestGatewayConfig = GatewayConfig<
  OpenApiRestDriver,
  AnyOperations<OpenApiRestDriver>
>;

export function openapiRest(
  config: OpenApiRestDriverConfig,
): OpenApiRestDriver {
  return {
    type: OPENAPI_REST_DRIVER_TYPE,
    // Loaded on first call, not at import, so codegen never evaluates the runtime.
    createExecutor: (
      config: OpenApiRestGatewayConfig,
      options: ExecutorOptions,
    ) =>
      import("../runtime/executor.ts").then((m) =>
        m.createExecutor(config, options),
      ),
    // Build-time only, so it is imported statically: nothing here reaches the network, a
    // secret or the environment.
    checkSchemas: checkOperationSchemas,
    spec: config.spec,
    auth: config.auth,
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    ...(config.maxResponseBytes !== undefined
      ? { maxResponseBytes: config.maxResponseBytes }
      : {}),
  };
}
