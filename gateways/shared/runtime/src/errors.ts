export type SignalRuling =
  "none" | "trust" | "upstream_failure" | "upstream_success" | "unhandled";

export const ERROR_CODES = {
  INVALID_INPUT: { signal: "none" },
  OPERATION_NOT_FOUND: { signal: "none" },
  SECURE_VALUE_MISMATCH: { signal: "trust" },
  SECURE_SIGNATURE_INVALID: { signal: "trust" },
  UPSTREAM_CONTRACT_VIOLATION: { signal: "upstream_failure" },
  UPSTREAM_TIMEOUT: { signal: "upstream_failure" },
  UPSTREAM_REJECTED: { signal: "upstream_success" },
  NOT_FOUND: { signal: "upstream_success" },
  INTERNAL: { signal: "unhandled" },
} as const satisfies Record<string, { signal: SignalRuling }>;

export type ErrorCode = keyof typeof ERROR_CODES;

export class GatewayError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
  }
}
