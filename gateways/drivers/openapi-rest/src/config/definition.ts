import type {
  AnyOperations,
  DriverDefinition,
  ExecutorOptions,
  GatewayConfig,
} from "@repo/gateway-config";
import type { JSONSchema } from "@repo/gateway-types";

import type { MetadataConfig } from "../metadata.ts";
import {
  type HttpMethod,
  OPENAPI_REST_DRIVER_TYPE,
  type OpenApiRestHandler,
} from "../types.ts";
import type { OpenApiRestAuth } from "./auth.ts";
import { checkOperationSchemas } from "./check.ts";
import type { SecretField } from "./secret-field.ts";

// Behaviour lives here, reviewed with the gateway. Deployment values, the target and the
// secret, arrive as executor options instead; the configuration names only the secret's fields.
export interface OpenApiRestDriverConfig {
  // Location of the OpenAPI document describing the upstream: an https URL, or a path within
  // the gateway's directory. The gateway's schemas are derived from it when someone runs
  // `gateway-schemas`; nothing fetches it at runtime or when generating.
  readonly spec: string;
  // Static headers sent on every request, such as an API version.
  readonly headers?: Readonly<Record<string, string>>;
  // Largest response body the driver buffers, in bytes. Defaults to 1 MiB.
  readonly maxResponseBytes?: number;
  // What the gateway reports about an exchange beside its result, by the name a caller reads it
  // under: the response header it is read from, and the schema of the scalar it carries. An
  // upstream's own id for a request, say. Returned on a failure as on a success, and logged.
  readonly metadata?: MetadataConfig;
  // How requests are authenticated: the parts in order, each shown the headers the ones before
  // it set, so `[apiKey(…), sigV4(…)]` signs the key. Each names the secret fields it reads and
  // the headers it owns. Required, so a gateway that sends no credential says so, as `[]`.
  readonly auth: readonly OpenApiRestAuth[];
  // Where the upstream is, when a field of the secret says so: an upstream that provides the
  // secret often keeps its address there too. Read when the executor is created, and used in
  // place of UPSTREAM_TARGET when both are there; with neither, the executor refuses to start.
  readonly target?: SecretField;
}

// What derives a gateway's schemas from `spec`, found from this module wherever the package is
// installed. A URL and not an import: the bundler does not follow one.
const DERIVE_MODULE = new URL("../derive/index.ts", import.meta.url).href;

export type UpstreamTemplate = `${HttpMethod} /${string}`;

// Where one input field goes, in the OpenAPI document's own vocabulary. `name` is the upstream
// parameter or header when it differs from the input field.
export interface ParameterMapping {
  readonly in: "path" | "query" | "header";
  readonly name?: string;
}

// What an operation states of its schemas that the upstream's document leaves open. Where the
// document admits an object of any shape, or any value at all, what is stated takes its place;
// anywhere else it is set into what the document says, so it makes a schema admit less and never
// more or other than the upstream describes.
export interface OperationNarrowing {
  // The request body, set in as written: close an object here to refuse fields it does not list.
  readonly payload?: JSONSchema;
  // An outcome's data, by the outcome's name, held to its shape as any outcome is.
  readonly outcomes?: Readonly<Record<string, JSONSchema>>;
}

// The caller's input is one flat object and does not know how it maps to HTTP. The operation
// declares that per field: a path parameter, a query parameter or a header. Every path
// parameter in the template needs an entry. The request body, when there is one, travels under
// the top-level `payload` field.
export type OpenApiRestOperationFields = {
  readonly upstream: UpstreamTemplate;
  readonly parameters?: Readonly<Record<string, ParameterMapping>>;
  // The path template of the upstream's document that serves this operation's path, where the
  // document does not declare the path itself: "/v1/{resourcePath+}" for "GET /v1/notifications".
  // Said, never inferred. A template that takes any path serves one the document has not
  // described, so nothing in the document says what this operation sends or gets back; an
  // operation that goes through one does so because someone wrote that it should, and deriving
  // fails for a path the document lacks and no `matches` accounts for. The request is sent to
  // the path in `upstream` either way; only deriving reads this.
  readonly matches?: `/${string}`;
  // What the document leaves unsaid: a body or a field of any shape, as a template that takes
  // any path usually has. The shape a gateway's own services keep there is theirs to state.
  readonly narrow?: OperationNarrowing;
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
    // Given, never imported: what it needs to read an OpenAPI document must not follow this
    // module into a deployed gateway, and the bundler follows every import it can see.
    deriveSchemasModule: DERIVE_MODULE,
    spec: config.spec,
    auth: config.auth,
    ...(config.target !== undefined ? { target: config.target } : {}),
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    ...(config.maxResponseBytes !== undefined
      ? { maxResponseBytes: config.maxResponseBytes }
      : {}),
    ...(config.metadata !== undefined ? { metadata: config.metadata } : {}),
  };
}
