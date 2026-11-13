// The SDK's entry: what a domain installs and imports.

export type { Caller } from "./caller.ts";
export type {
  Domain,
  DomainConfig,
  HeaderDeclaration,
  HeaderDeclarations,
  ResponseDeclarations,
  RouteDeclaration,
  RouteDeclarations,
} from "./config.ts";
export { domain } from "./config.ts";
export { currentCaller } from "./context.ts";
export type {
  ErrorBody,
  ErrorType,
  FailureCode,
  GatewayFailureCode,
  PlatformFailureCode,
  RouteFailureCode,
} from "./errors.ts";
export { Failure, fromGatewayError } from "./errors.ts";
export type { HttpMethod, RouteRequest, RouteResponse } from "./http.ts";
export { log } from "./logging/log.ts";
export type {
  Log,
  LogFields,
  LoggingOptions,
  LogLevel,
} from "./logging/logger.ts";
export type {
  Handler,
  RouteContext,
  RouteFactory,
  RouteHandler,
  RouteKey,
  RouteResult,
} from "./types.ts";
