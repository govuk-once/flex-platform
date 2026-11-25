// The answers the SDK writes itself, in the platform's failure body. The Frontdoor answers the
// same statuses with the same bodies, so the app reads a failure the same way whoever sent it.

import { MEDIA_TYPE_JSON, REJECTED_BY_HEADER } from "../http.ts";

export const PLATFORM_ERRORS = {
  400: { type: "client_error", message: "Bad request" },
  404: { type: "client_error", message: "Not found" },
  405: { type: "client_error", message: "Method not allowed" },
  415: { type: "client_error", message: "Unsupported media type" },
  500: { type: "server_error", message: "Internal server error" },
  502: { type: "server_error", message: "Bad gateway" },
  503: { type: "server_error", message: "Service unavailable" },
  504: { type: "server_error", message: "Gateway timeout" },
} as const;

export type PlatformErrorStatus = keyof typeof PLATFORM_ERRORS;

export function jsonResponse(
  status: number,
  text: string,
  headers: HeadersInit = {},
): Response {
  const response = new Response(text, { status, headers });

  response.headers.set("content-type", MEDIA_TYPE_JSON);

  return response;
}

/** A failure in the platform's body, as a handler's server error is answered. */
export function platformErrorResponse(
  status: PlatformErrorStatus,
  headers: HeadersInit = {},
): Response {
  const { message, type } = PLATFORM_ERRORS[status];

  return jsonResponse(status, JSON.stringify({ message, type }), headers);
}

// The SDK's own answer, in place of the handler's. The Frontdoor and API Gateway each name
// themselves on theirs in the same header, so a caller can tell who answered.
export function refusalResponse(
  status: PlatformErrorStatus,
  headers: HeadersInit = {},
): Response {
  const response = platformErrorResponse(status, headers);

  response.headers.set(REJECTED_BY_HEADER, "domain");

  return response;
}
