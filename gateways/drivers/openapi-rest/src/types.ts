import type { BrandedHandler } from "@repo/gateway-config";
import type { OperationResult } from "@repo/gateway-types";

export const OPENAPI_REST_DRIVER_TYPE = "openapi-rest";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

export const METHODS_WITH_BODY: ReadonlySet<HttpMethod> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

// The input field carrying the request body. Never a mapping target, so it cannot double as a
// path or query parameter. Named here rather than in the executor because the build-time check
// reads it as well.
export const PAYLOAD_FIELD = "payload";

// Outcome names are fixed by the driver so callers discriminate on a stable string and never
// see a status code.
export type OpenApiRestOutcome = "ok" | "created" | "accepted" | "no_content";

export type Scalar = string | number | boolean;

export type QueryValue = Scalar | readonly Scalar[];

// One upstream request, relative to the target base URL. `path` is already resolved and
// percent-encoded. `body` is serialised as JSON when present.
export interface OpenApiRestCall {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface OpenApiRestResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  // Parses the body as JSON; null when empty. Throws UPSTREAM_CONTRACT_VIOLATION otherwise.
  json(): unknown;
}

// Every upstream call goes through the client, which makes exactly one ctx.upstream call per
// request and converts transport failures to GatewayError in one place.
export interface OpenApiRestClient {
  // The automatic mapping of this operation's input to a request.
  prepare(input: unknown): OpenApiRestCall;
  // Sends a request and returns the raw status and body. 4xx and 5xx are not errors here.
  request(call: OpenApiRestCall): Promise<OpenApiRestResponse>;
  // The driver's status mapping for a response already received. Throws the mapped GatewayError
  // for error statuses.
  mapResponse(
    response: OpenApiRestResponse,
  ): OperationResult<OpenApiRestOutcome>;
  // request() followed by mapResponse().
  invoke(call: OpenApiRestCall): Promise<OperationResult<OpenApiRestOutcome>>;
}

// Branded with this driver's type, which defineHandler applies, so an operation's `handler`
// must come from this driver. The input and outcome types the author declared are kept, so a
// generated contract can check them against the operation's schemas. The defaults name the
// widest handler: `never` input accepts any declared input, and any outcome is a string.
export type OpenApiRestHandler<
  TInput = never,
  TOutcome extends string = string,
> = BrandedHandler<
  typeof OPENAPI_REST_DRIVER_TYPE,
  (
    input: TInput,
    client: OpenApiRestClient,
  ) => Promise<OperationResult<TOutcome>>
>;
