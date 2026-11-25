export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export const SUCCESS_STATUS_CODES = [
  200, 201, 202, 203, 204, 205, 206, 207, 208, 226,
] as const;

export type SuccessStatusCode = (typeof SUCCESS_STATUS_CODES)[number];

// The 4xx statuses a route may answer with of its own. 401 and 403 are left out because the app
// reads either, from any request, as an expired token: it refreshes its tokens and sends the
// request again. Those about the request's method, headers, length or media type are left out
// because the SDK or API Gateway answers them, so a route's own would be indistinguishable.
export const FAILURE_STATUS_CODES = [
  400, 402, 404, 409, 410, 412, 413, 422, 423, 424, 425, 428, 429, 451,
] as const;

export type FailureStatusCode = (typeof FAILURE_STATUS_CODES)[number];

/** The statuses a route may declare in `responses`. */
export const RESPONSE_STATUS_CODES: readonly [
  ...typeof SUCCESS_STATUS_CODES,
  ...typeof FAILURE_STATUS_CODES,
] = [...SUCCESS_STATUS_CODES, ...FAILURE_STATUS_CODES];

export type ResponseStatusCode = (typeof RESPONSE_STATUS_CODES)[number];

// What can go wrong on any route, such as a gateway that did not answer. No route declares
// these, and any handler may answer with one.
export const SERVER_ERROR_STATUS_CODES = [500, 502, 503, 504] as const;

export type ServerErrorStatusCode = (typeof SERVER_ERROR_STATUS_CODES)[number];

// The 2xx statuses the Fetch standard calls null body statuses: a response with one carries no
// body, and a `Response` built with one throws.
export const NULL_BODY_STATUS_CODES = [204, 205] as const;

export type NullBodyStatusCode = (typeof NULL_BODY_STATUS_CODES)[number];

export const MEDIA_TYPE_JSON = "application/json";

export const CALLER_TOKEN_HEADER = "x-flex-secure";

export const CORRELATION_ID_HEADER = "x-correlation-id";

export const REJECTED_BY_HEADER = "x-rejected-by";
