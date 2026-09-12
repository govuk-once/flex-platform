// Shared shapes and error metadata with no package dependencies. Consumers can name the wire
// contract without installing the runtime. Parsing and GatewayError remain in the runtime.
export type {
  EnvelopeError,
  EnvelopeInbound,
  EnvelopeResponse,
  EnvelopeSuccess,
  SecureValue,
} from "./envelope.ts";
export type { ErrorCode, ErrorRuling, SignalRuling } from "./errors.ts";
export { ERROR_CODES } from "./errors.ts";
export type { Validator } from "./validator.ts";
