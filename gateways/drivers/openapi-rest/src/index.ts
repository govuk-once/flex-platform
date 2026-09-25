// Registers the path-parameter refinement with defineGateway for every consumer of this package.
import "./config/refine.ts";

export type {
  OpenApiRestAuth,
  OpenApiRestAuthCall,
  OpenApiRestAuthDeps,
  OpenApiRestAuthInstance,
  OpenApiRestAuthRequest,
  OpenApiRestAuthTransport,
} from "./config/auth.ts";
export { apiKey, defineAuth } from "./config/auth.ts";
export type {
  OpenApiRestDriver,
  OpenApiRestDriverConfig,
  OpenApiRestOperationFields,
  ParameterMapping,
  UpstreamTemplate,
} from "./config/definition.ts";
export type { OpenApiRestGatewayConfig } from "./config/definition.ts";
export { openapiRest } from "./config/definition.ts";
export { defineHandler } from "./config/handler.ts";
export type {
  SecretField,
  SecretValues,
  Setting,
} from "./config/secret-field.ts";
export { fromSecret } from "./config/secret-field.ts";
export type { SigV4Options, SigV4Role } from "./config/sigv4.ts";
export { sigV4 } from "./config/sigv4.ts";
export type { MetadataConfig, ResponseMetadata } from "./metadata.ts";
export { encodePathParam } from "./path.ts";
export type { OpenApiRestOperationConfig } from "./runtime/operation.ts";
export type {
  HttpMethod,
  OpenApiRestCall,
  OpenApiRestClient,
  OpenApiRestHandler,
  OpenApiRestOutcome,
  OpenApiRestResponse,
  QueryValue,
  Scalar,
} from "./types.ts";
export { OPENAPI_REST_DRIVER_TYPE } from "./types.ts";
