// Shared shapes, error metadata and gateway names, depending only on @repo/utils. Consumers can
// name the wire contract without installing the runtime. Parsing and GatewayError remain in the
// runtime.
export type {
  DriverContext,
  DriverLogFields,
  DriverLogger,
  ExecuteFn,
  OperationHandler,
  OperationResult,
} from "./driver.ts";
export type {
  EnvelopeError,
  EnvelopeInbound,
  EnvelopeMeta,
  EnvelopeResponse,
  EnvelopeSuccess,
  MetaValue,
  SecureValue,
} from "./envelope.ts";
export type { ErrorCode, ErrorRuling, SignalRuling } from "./errors.ts";
export { ERROR_CODES } from "./errors.ts";
export {
  assertGatewayId,
  GATEWAY_FUNCTION_ALIAS,
  gatewayFunctionName,
  gatewayFunctionPrefix,
} from "./names.ts";
export type {
  GatewaySchemas,
  JSONSchema,
  OperationSchemas,
} from "./schemas.ts";
export type {
  SecretObject,
  SecretProvider,
  SecretReadOptions,
} from "./secret.ts";
export type { Validator } from "./validator.ts";
