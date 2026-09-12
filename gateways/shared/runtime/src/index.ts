// Re-export the wire contract so handler authors can use a single runtime import.
// Consumers needing only shared types can import @repo/gateway-types directly.
export type { DeadlineProvider, DriverContext } from "./context.ts";
export { parseDuration } from "./duration.ts";
export { parseEnvelope } from "./envelope.ts";
export { GatewayError } from "./errors.ts";
export type { AnyGatewayConfig, HandlerDeps } from "./handler.ts";
export { createHandler } from "./handler.ts";
export type { CompiledPath, Logger } from "./logging.ts";
export { compilePaths, pickFields } from "./logging.ts";
export type { ResolvedPolicy } from "./policy.ts";
export { resolvePolicy } from "./policy.ts";
export { checkSecureBindings, prepareSecurePayload } from "./secure.ts";
export type {
  EnvelopeError,
  EnvelopeInbound,
  EnvelopeResponse,
  EnvelopeSuccess,
  ErrorCode,
  ErrorRuling,
  SecureValue,
  SignalRuling,
  Validator,
} from "@repo/gateway-types";
export { ERROR_CODES } from "@repo/gateway-types";
