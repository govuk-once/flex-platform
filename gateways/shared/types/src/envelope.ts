import type { ErrorCode } from "./errors.ts";

// Scalars avoid nested key-order concerns when preparing the secure payload.
export type SecureValue = string | number | boolean | null;

export interface EnvelopeInbound {
  readonly operation: string;
  readonly input: unknown;
  readonly secure: {
    readonly values: Readonly<Record<string, SecureValue>>;
    readonly signature: string;
  };
}

export interface EnvelopeSuccess {
  readonly ok: true;
  readonly outcome: string;
  readonly data: unknown;
}

// Return a stable error code without exposing diagnostic messages in the response.
export interface EnvelopeError {
  readonly ok: false;
  readonly error: {
    readonly code: ErrorCode;
  };
}

export type EnvelopeResponse = EnvelopeSuccess | EnvelopeError;
