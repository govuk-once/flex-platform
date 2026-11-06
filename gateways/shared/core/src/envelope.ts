import type { ErrorCode } from "./errors.ts";

/**
 * The values the caller token vouches for, which an operation's secure bindings compare its input
 * with. Each is a string. A name added here is a claim the edge signs.
 */
export const SECURE_CLAIMS = ["pairwiseId", "service"] as const;

export type SecureClaim = (typeof SECURE_CLAIMS)[number];

export type SecureClaims = Readonly<Record<SecureClaim, string>>;

export interface EnvelopeInbound {
  readonly operation: string;
  readonly input: unknown;
  /**
   * The caller token, as the edge signed it and the domain received it. Without it, the gateway
   * refuses the call as `UNAUTHENTICATED`.
   */
  readonly secure?: {
    readonly token: string;
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
