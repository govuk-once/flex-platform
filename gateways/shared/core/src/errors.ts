export type SignalRuling =
  "none" | "trust" | "upstream_failure" | "upstream_success" | "unhandled";

export interface ErrorRuling {
  readonly signal: SignalRuling;
}

// Written without `satisfies`, so its declaration can be written from this module alone, as the
// published gateway client's bundled declarations are. errors.test.ts checks every ruling.
export const ERROR_CODES = {
  INVALID_INPUT: { signal: "none" },
  OPERATION_NOT_FOUND: { signal: "none" },
  UNAUTHENTICATED: { signal: "trust" },
  SECURE_VALUE_MISMATCH: { signal: "trust" },
  SECURE_SIGNATURE_INVALID: { signal: "trust" },
  UPSTREAM_CONTRACT_VIOLATION: { signal: "upstream_failure" },
  UPSTREAM_ERROR: { signal: "upstream_failure" },
  UPSTREAM_TIMEOUT: { signal: "upstream_failure" },
  UPSTREAM_REJECTED: { signal: "upstream_success" },
  NOT_FOUND: { signal: "upstream_success" },
  UPSTREAM_UNAVAILABLE: { signal: "none" },
  RATE_LIMITED: { signal: "none" },
  INTERNAL: { signal: "unhandled" },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
