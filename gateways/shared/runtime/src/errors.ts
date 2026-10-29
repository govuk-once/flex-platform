import type { ErrorCode } from "@repo/gateway-core";

// A deliberate diagnostic. Its message is written to be logged; the runtime records it as is.
export class GatewayError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
  }
}
