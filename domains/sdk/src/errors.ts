// The failures a route answers with, each a fixed status and a fixed body. The body is
// `{ message, type, code }`: the Frontdoor's two fields, with text the platform wrote, and the
// code a client can switch on. Nothing a caller, a library or an upstream wrote reaches a body.

import type { InvocationFailure } from "@govuk-once/flex-gateway-client";
import type { ErrorCode } from "@repo/gateway-core";

export type ErrorType = "auth_error" | "client_error" | "server_error";

interface FailureDefinition {
  readonly status: number;
  readonly type: ErrorType;
  readonly message: string;
}

export type FailureCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unsupported_media_type"
  | "unprocessable"
  | "internal"
  | "bad_gateway"
  | "unavailable"
  | "timeout";

// Annotated, as the published declarations are written from each module alone.
const FAILURES: Readonly<Record<FailureCode, FailureDefinition>> = {
  invalid_request: {
    status: 400,
    type: "client_error",
    message: "Invalid request",
  },
  unauthorized: { status: 401, type: "auth_error", message: "Unauthorized" },
  forbidden: { status: 403, type: "auth_error", message: "Forbidden" },
  not_found: { status: 404, type: "client_error", message: "Not found" },
  conflict: { status: 409, type: "client_error", message: "Conflict" },
  unsupported_media_type: {
    status: 415,
    type: "client_error",
    message: "Unsupported media type",
  },
  unprocessable: {
    status: 422,
    type: "client_error",
    message: "Unprocessable request",
  },
  internal: {
    status: 500,
    type: "server_error",
    message: "Internal server error",
  },
  bad_gateway: { status: 502, type: "server_error", message: "Bad gateway" },
  unavailable: {
    status: 503,
    type: "server_error",
    message: "Service unavailable",
  },
  timeout: { status: 504, type: "server_error", message: "Gateway timeout" },
};

/** The failures a route may declare in `errors`, and its handler then return with `fail`. */
export type RouteFailureCode =
  "invalid_request" | "forbidden" | "not_found" | "conflict" | "unprocessable";

/** The failures any handler may return, because the platform raised them, not the route. */
export type PlatformFailureCode = Exclude<
  FailureCode,
  RouteFailureCode | "unauthorized" | "unsupported_media_type"
>;

export const ROUTE_FAILURE_CODES: readonly RouteFailureCode[] = [
  "invalid_request",
  "forbidden",
  "not_found",
  "conflict",
  "unprocessable",
];

export interface ErrorBody {
  readonly message: string;
  readonly type: ErrorType;
  readonly code: FailureCode;
}

/**
 * A failure a handler answers with instead of a response, returned or thrown. Made by `fail` in a
 * handler's context, for a code the route declares, or by `fromGatewayError` for a gateway's
 * answer. Its message is the fixed text the body carries.
 */
export class Failure<Code extends FailureCode = FailureCode> extends Error {
  override readonly name = "Failure";

  constructor(readonly code: Code) {
    super(FAILURES[code].message);
  }

  get status(): number {
    return FAILURES[this.code].status;
  }
}

export function fail<Code extends FailureCode>(code: Code): Failure<Code> {
  return new Failure(code);
}

export function statusOf(code: FailureCode): number {
  return FAILURES[code].status;
}

export function errorBody(code: FailureCode): ErrorBody {
  const { type, message } = FAILURES[code];
  return { message, type, code };
}

/** What `fromGatewayError` answers with. A route that passes a gateway's errors on declares the two route failures among them. */
export type GatewayFailureCode =
  PlatformFailureCode | "forbidden" | "not_found";

// The default mapping from a gateway's error code to the status a domain answers with, applied
// only where a handler passes a gateway's error on. A gateway refuses the input the domain built,
// an operation the domain named or the caller the domain asserted: each of those is the domain's
// fault, not its caller's, so they are a 502. What the upstream itself said is passed on: not
// found stays not found, a timeout stays a timeout. A mismatch of the caller's values is the
// one answer about the caller rather than the domain, and is forbidden.
const GATEWAY_ERRORS: Readonly<Record<ErrorCode, GatewayFailureCode>> = {
  INVALID_INPUT: "bad_gateway",
  OPERATION_NOT_FOUND: "bad_gateway",
  UNAUTHENTICATED: "bad_gateway",
  SECURE_VALUE_MISMATCH: "forbidden",
  SECURE_SIGNATURE_INVALID: "bad_gateway",
  UPSTREAM_CONTRACT_VIOLATION: "bad_gateway",
  UPSTREAM_ERROR: "bad_gateway",
  UPSTREAM_TIMEOUT: "timeout",
  UPSTREAM_REJECTED: "bad_gateway",
  NOT_FOUND: "not_found",
  UPSTREAM_UNAVAILABLE: "unavailable",
  RATE_LIMITED: "unavailable",
  INTERNAL: "bad_gateway",
};

/** The failure to answer with for a gateway's error, which a gateway returns and never throws. */
export function fromGatewayError(code: ErrorCode): Failure<GatewayFailureCode> {
  return new Failure(GATEWAY_ERRORS[code]);
}

// A call the gateway did not answer. The client throws these, so a handler that does not catch
// one lets it reach the route, which maps it here.
const INVOCATION_FAILURES: Readonly<
  Record<InvocationFailure, PlatformFailureCode>
> = {
  timed_out: "timeout",
  function_error: "bad_gateway",
  invalid_response: "bad_gateway",
  invoke_failed: "internal",
  aborted: "internal",
};

export function fromInvocationFailure(
  reason: InvocationFailure,
): Failure<PlatformFailureCode> {
  return new Failure(INVOCATION_FAILURES[reason]);
}
