export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export const SUCCESS_STATUS_CODES = [
  200, 201, 202, 203, 204, 205, 206, 207, 208, 226,
] as const;

export type SuccessStatusCode = (typeof SUCCESS_STATUS_CODES)[number];

// The 2xx statuses the Fetch standard calls null body statuses: a response with one carries no
// body, and a `Response` built with one throws.
export const NULL_BODY_STATUS_CODES = [204, 205] as const;

export type NullBodyStatusCode = (typeof NULL_BODY_STATUS_CODES)[number];
