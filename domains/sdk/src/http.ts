// What a route is given and what it answers. Nothing of API Gateway's event or of the router
// that matched the request reaches a route: the function's entry point (the Hono wrapper) reads
// the event into a RouteRequest and writes the RouteResponse back, so a route can be driven in a
// test with a plain object.

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const HTTP_METHODS: readonly HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
];

export interface RouteRequest {
  /** The path's parameters, as the router matched them against the route's path. */
  readonly params: Readonly<Record<string, string>>;
  /** The query string, decoded, one value per name. */
  readonly query: Readonly<Record<string, string>>;
  /** The request's headers, one value per name, in whatever case they arrived. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body as text, or null when the request has none. */
  readonly body: string | null;
  /**
   * When the function is stopped, in epoch milliseconds: now plus the time Lambda says remains.
   * The route keeps its own margin inside it for answering.
   */
  readonly deadline: number;
  /** Lambda's id for the invocation, carried on every log line of the request. */
  readonly requestId?: string;
}

export interface RouteResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Serialised; empty for a response with no body. */
  readonly body: string;
}

export const CORRELATION_HEADER = "x-correlation-id";
export const TRACE_HEADER = "x-amzn-trace-id";
export const CONTENT_TYPE_HEADER = "content-type";
export const JSON_MEDIA_TYPE = "application/json";

/** The same headers, each name in lower case, so a lookup by name is case-insensitive. */
export function lowerCaseHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name.toLowerCase()] = value;
  }
  return result;
}

/** The media type of a Content-Type header, without its parameters, in lower case. */
export function mediaType(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined;
  const [type] = contentType.split(";");
  return type?.trim().toLowerCase();
}

/** The X-Ray trace's root id, which `X-Amzn-Trace-Id` carries as `Root=...` among other fields. */
export function traceRoot(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const field of header.split(";")) {
    const [name, value] = field.split("=");
    if (name?.trim() === "Root" && value !== undefined && value !== "") {
      return value.trim();
    }
  }
  return undefined;
}
