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

// What a gateway reports about an exchange beside its result: an upstream's own id for the
// request, say, which is what its support asks for. Scalars under names the gateway declares,
// each validated before it is returned. Every one may be absent, and so may the whole: a
// request refused before it reached the upstream, or one whose response never arrived, has
// nothing to report. Never a diagnostic message; those stay in logs.
export type MetaValue = string | number | boolean;

export type EnvelopeMeta = Readonly<Record<string, MetaValue>>;

export interface EnvelopeSuccess {
  readonly ok: true;
  readonly outcome: string;
  readonly data: unknown;
  readonly meta?: EnvelopeMeta;
}

// Return a stable error code without exposing diagnostic messages in the response.
export interface EnvelopeError {
  readonly ok: false;
  readonly error: {
    readonly code: ErrorCode;
  };
  readonly meta?: EnvelopeMeta;
}

export type EnvelopeResponse = EnvelopeSuccess | EnvelopeError;
