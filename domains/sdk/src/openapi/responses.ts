// Every response an operation describes: those its route declares, and those any route gives
// without declaring them, which the SDK sends from `PLATFORM_ERRORS` in the platform's failure
// body. A route's own 400 and the SDK's take `anyOf` the two bodies: `oneOf` would refuse a route's
// body that also matches `PlatformError`. The 404 and 405 for a path or method no route has belong
// to no operation. The Frontdoor's and API Gateway's answers are the platform's to add when a
// document is published.

import type { ResponseStatusCode, ServerErrorStatusCode } from "../http.ts";
import { MEDIA_TYPE_JSON, SERVER_ERROR_STATUS_CODES } from "../http.ts";
import { PLATFORM_ERRORS } from "../runtime/responses.ts";
import { COMPONENTS_REF } from "./schemas.ts";
import type { Content, JsonSchema, OpenApiResponse } from "./types.ts";

export const PLATFORM_ERROR = "PlatformError";

const PLATFORM_ERROR_REF: JsonSchema = {
  $ref: `${COMPONENTS_REF}${PLATFORM_ERROR}`,
};

// `type` lists only what the SDK sends.
export const PLATFORM_ERROR_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
    type: {
      enum: [
        ...new Set(Object.values(PLATFORM_ERRORS).map(({ type }) => type)),
      ],
    },
  },
  required: ["message", "type"],
  additionalProperties: false,
};

// A status a route may declare fails the typecheck until it has a name here.
const STATUS_NAMES: Readonly<Record<ResponseStatusCode, string>> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No content",
  400: "Bad request",
  404: "Not found",
  409: "Conflict",
  410: "Gone",
  422: "Unprocessable content",
  429: "Too many requests",
};

interface UndeclaredResponse {
  readonly description: string;
  readonly onlyWithRequestBody: boolean;
}

// A route with no query or body still refuses one sent, so every operation can answer 400. The 5xx
// descriptions are the messages the SDK sends.
const UNDECLARED_RESPONSES: ReadonlyMap<number, UndeclaredResponse> = new Map([
  [
    400,
    {
      description: "A query, path parameter or body the route refuses",
      onlyWithRequestBody: false,
    },
  ],
  [415, { description: "The body is not JSON", onlyWithRequestBody: true }],
  ...SERVER_ERROR_STATUS_CODES.map(
    (status: ServerErrorStatusCode): [number, UndeclaredResponse] => [
      status,
      {
        description: PLATFORM_ERRORS[status].message,
        onlyWithRequestBody: false,
      },
    ],
  ),
]);

function isResponseStatusCode(status: number): status is ResponseStatusCode {
  return Object.hasOwn(STATUS_NAMES, status);
}

export function jsonContent(schema: JsonSchema): Content {
  return { [MEDIA_TYPE_JSON]: { schema } };
}

function declaredResponse(
  status: number,
  schema: JsonSchema | null,
): OpenApiResponse {
  return {
    description: isResponseStatusCode(status)
      ? STATUS_NAMES[status]
      : String(status),
    ...(schema === null ? {} : { content: jsonContent(schema) }),
  };
}

// A status the route declares and the SDK also answers.
function sharedResponse(own: OpenApiResponse): OpenApiResponse {
  const ownSchema = own.content?.[MEDIA_TYPE_JSON]?.schema;

  if (ownSchema === undefined) {
    return {
      description: `${own.description}, from the route with no body, or from the SDK`,
      content: jsonContent(PLATFORM_ERROR_REF),
    };
  }

  return {
    description: `${own.description}, from the route, or from the SDK`,
    content: jsonContent({ anyOf: [ownSchema, PLATFORM_ERROR_REF] }),
  };
}

export function responsesOf(
  declared: ReadonlyMap<number, JsonSchema | null>,
  takesBody: boolean,
): Record<number, OpenApiResponse> {
  const responses: Record<number, OpenApiResponse> = {};

  for (const [status, schema] of declared) {
    responses[status] = declaredResponse(status, schema);
  }

  for (const [status, undeclared] of UNDECLARED_RESPONSES) {
    if (undeclared.onlyWithRequestBody && !takesBody) continue;

    const own = responses[status];

    responses[status] =
      own === undefined
        ? {
            description: undeclared.description,
            content: jsonContent(PLATFORM_ERROR_REF),
          }
        : sharedResponse(own);
  }

  return responses;
}
