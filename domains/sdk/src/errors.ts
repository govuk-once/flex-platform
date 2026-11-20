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
