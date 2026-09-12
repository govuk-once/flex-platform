import type { ErrorCode } from "@repo/gateway-types";

export class GatewayError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
  }
}
