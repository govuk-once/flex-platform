// The failures a domain answers with, each a fixed status and a fixed body. The body is
// `{ message, type, code }`, with text the platform wrote, so nothing a caller, a library or an
// upstream wrote reaches it.

import { z } from "zod";

export type ErrorType = "auth_error" | "client_error" | "server_error";

export const ROUTE_REJECTION_CODES = [
  "invalid_request",
  "forbidden",
  "not_found",
  "conflict",
  "unprocessable",
] as const;

/** The codes a route may list in `errors`, and its handler then reject with. */
export type RouteRejectionCode = (typeof ROUTE_REJECTION_CODES)[number];

export const HANDLER_REJECTION_CODES = [
  "internal",
  "bad_gateway",
  "unavailable",
  "timeout",
] as const;

/** The codes any handler may reject with, without the route listing them. */
export type HandlerRejectionCode = (typeof HANDLER_REJECTION_CODES)[number];

export const PIPELINE_ERROR_CODES = [
  "unauthorized",
  "method_not_allowed",
  "unsupported_media_type",
] as const;

/**
 * The codes only the pipeline answers with, before a handler runs. It answers with some of the
 * others too, such as `invalid_request` for a request its schemas refuse.
 */
export type PipelineErrorCode = (typeof PIPELINE_ERROR_CODES)[number];

export type ErrorCode =
  RouteRejectionCode | HandlerRejectionCode | PipelineErrorCode;

interface ErrorDefinition {
  readonly status: number;
  readonly type: ErrorType;
  readonly message: string;
}

// Annotated, as the published declarations are written from each module alone.
export const ERRORS: Readonly<Record<ErrorCode, ErrorDefinition>> = {
  invalid_request: {
    status: 400,
    type: "client_error",
    message: "Invalid request",
  },
  unauthorized: { status: 401, type: "auth_error", message: "Unauthorized" },
  forbidden: { status: 403, type: "auth_error", message: "Forbidden" },
  not_found: { status: 404, type: "client_error", message: "Not found" },
  method_not_allowed: {
    status: 405,
    type: "client_error",
    message: "Method not allowed",
  },
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

export interface ErrorBody {
  readonly code: ErrorCode;
  readonly type: ErrorType;
  readonly message: string;
}

export const ErrorBodySchema: z.ZodType<ErrorBody> = z.object({
  code: z.enum([
    ...ROUTE_REJECTION_CODES,
    ...HANDLER_REJECTION_CODES,
    ...PIPELINE_ERROR_CODES,
  ]),
  type: z.enum(["auth_error", "client_error", "server_error"]),
  message: z.string(),
});
