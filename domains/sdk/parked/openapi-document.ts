// A domain's public API as an OpenAPI 3.1 document, as a client calling it through the Frontdoor
// meets it: exactly the declared routes, the SDK's own answers, and the Frontdoor's. It is built
// from the configuration alone, and no handler runs. The platform never sees a domain's
// configuration, so nothing later adds the Frontdoor's part: the whole document is built here.
//
// 404 and 405, for a path or method no route has, are not described: they belong to no operation.

import { STATUS_CODES } from "node:http";

import type { ZodType } from "zod";
import { toJSONSchema, ZodDefault, ZodOptional } from "zod";

import { DomainConfigError } from "../src/check-domain.ts";
import { CORRELATION_ID_HEADER, MEDIA_TYPE_JSON } from "../src/http.ts";
import { parseRouteKey } from "../src/route-key.ts";
import type { DomainConfig, RouteConfig } from "../src/types.ts";

const OPENAPI_VERSION = "3.1.0";

export interface OpenApiResponse {
  readonly description: string;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly content?: Readonly<Record<string, { readonly schema: unknown }>>;
}

export interface OpenApiParameter {
  readonly name: string;
  readonly in: "path" | "query";
  readonly required: boolean;
  readonly schema: unknown;
}

export interface OpenApiOperation {
  readonly operationId?: string;
  readonly description?: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: {
    readonly required: true;
    readonly content: Readonly<Record<string, { readonly schema: unknown }>>;
  };
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
}

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
  };
  readonly servers: readonly {
    readonly url: string;
    readonly variables: Readonly<Record<string, { readonly default: string }>>;
  }[];
  readonly security: readonly Readonly<Record<string, readonly string[]>>[];
  // Each path's operations, keyed by lowercase method.
  readonly paths: Readonly<
    Record<string, Readonly<Record<string, OpenApiOperation>>>
  >;
  readonly components: Readonly<Record<string, unknown>>;
}

export interface OpenApiOptions {
  /** The document's `info.version`. */
  readonly version: string;
  /** The document's `info.title`. The domain's name by default. */
  readonly title?: string;
}

// The Frontdoor's public host for each environment, and where it serves a domain's routes.
const SERVER_URL =
  "https://{environment}.flex-domainedge.once.service.gov.uk/app/";

// OpenAPI requires a default; the least harmful target for a call nobody chose.
const DEFAULT_ENVIRONMENT = "development";

const PLATFORM_ERROR_REF = { $ref: "#/components/schemas/PlatformError" };

const CORRELATION_ID_REF = { $ref: "#/components/headers/CorrelationId" };

const SECURITY_SCHEME = "callerToken";

const COMPONENTS = {
  schemas: {
    PlatformError: {
      type: "object",
      required: ["type", "message"],
      properties: {
        type: { type: "string" },
        message: { type: "string" },
      },
    },
  },
  headers: {
    CorrelationId: {
      description: "The request's trace ID, set by the Frontdoor",
      schema: { type: "string", pattern: "^1-[0-9a-f]{8}-[0-9a-f]{24}$" },
    },
  },
  securitySchemes: {
    [SECURITY_SCHEME]: {
      type: "http",
      scheme: "bearer",
      description: "The app's access token, verified by the Frontdoor",
    },
  },
};

function reason(status: number): string {
  return STATUS_CODES[status] ?? String(status);
}

function response(
  status: number,
  schema?: unknown,
  description = reason(status),
): OpenApiResponse {
  return {
    description,
    headers: { [CORRELATION_ID_HEADER]: CORRELATION_ID_REF },
    ...(schema === undefined
      ? {}
      : { content: { [MEDIA_TYPE_JSON]: { schema } } }),
  };
}

// What the Frontdoor, WAF and the SDK answer on a route, beside what the route declares.
function platformResponses(
  hasBody: boolean,
  ownBadRequest: unknown,
): Record<string, OpenApiResponse> {
  return {
    400: response(
      400,
      ownBadRequest === undefined
        ? PLATFORM_ERROR_REF
        : { oneOf: [ownBadRequest, PLATFORM_ERROR_REF] },
    ),
    401: response(
      401,
      PLATFORM_ERROR_REF,
      "The access token is missing or has expired",
    ),
    403: response(403, undefined, "Refused by the Frontdoor's firewall"),
    ...(hasBody
      ? {
          413: response(413, PLATFORM_ERROR_REF, "The body is over 16 KB"),
          415: response(415, PLATFORM_ERROR_REF),
        }
      : {}),
    429: response(429, PLATFORM_ERROR_REF),
    500: response(500, PLATFORM_ERROR_REF),
    502: response(502, PLATFORM_ERROR_REF),
    503: response(503, PLATFORM_ERROR_REF),
    504: response(504, PLATFORM_ERROR_REF),
  };
}

function isOptional(schema: unknown): boolean {
  return schema instanceof ZodOptional || schema instanceof ZodDefault;
}

// A description left out or blank describes nothing, so the document leaves it out.
function describedBy(description: string | undefined): {
  readonly description?: string;
} {
  return description === undefined || description.trim() === ""
    ? {}
    : { description };
}

/** Builds the document. Throws a DomainConfigError naming each schema JSON Schema cannot hold. */
export function buildOpenApiDocument(
  domain: DomainConfig,
  { version, title = domain.name }: OpenApiOptions,
): OpenApiDocument {
  const problems: string[] = [];

  const jsonSchema = (
    schema: ZodType,
    io: "input" | "output",
    at: string,
  ): unknown => {
    try {
      // OpenAPI 3.1 sets the dialect for the whole document, so no schema in it repeats one.
      const described = {
        ...toJSONSchema(schema, { target: "draft-2020-12", io }),
      };

      delete described.$schema;

      return described;
    } catch {
      problems.push(`${at}: cannot be described as JSON Schema`);

      return {};
    }
  };

  const paths: Record<string, Record<string, OpenApiOperation>> = {};

  const routes: readonly (readonly [string, RouteConfig])[] = Object.entries(
    domain.routes,
  );

  for (const [key, route] of routes) {
    const parsed = parseRouteKey(key);

    if (!parsed.ok) continue;

    const at = `routes[${JSON.stringify(key)}]`;

    const { description, params, query, body, responses, operationId } = route;

    const parameters: OpenApiParameter[] = [
      ...Object.entries<ZodType>(params?.shape ?? {}).map(([name, schema]) => ({
        name,
        in: "path" as const,
        required: true,
        schema: jsonSchema(schema, "input", `${at}.params.${name}`),
      })),
      ...Object.entries<ZodType>(query?.shape ?? {}).map(([name, schema]) => ({
        name,
        in: "query" as const,
        required: !isOptional(schema),
        schema: jsonSchema(schema, "input", `${at}.query.${name}`),
      })),
    ];

    const declared: Record<string, OpenApiResponse> = {};

    let ownBadRequest: unknown;

    for (const [status, schema] of Object.entries(responses)) {
      const described =
        schema === null || schema === undefined
          ? undefined
          : jsonSchema(schema, "output", `${at}.responses[${status}]`);

      if (status === "400") {
        ownBadRequest = described;
      } else {
        declared[status] = response(Number(status), described);
      }
    }

    const path = key.slice(key.indexOf(" ") + 1);

    paths[path] = {
      ...paths[path],
      [parsed.route.method.toLowerCase()]: {
        ...(operationId === undefined ? {} : { operationId }),
        ...describedBy(description),
        ...(parameters.length === 0 ? {} : { parameters }),
        ...(body === undefined
          ? {}
          : {
              requestBody: {
                required: true,
                content: {
                  [MEDIA_TYPE_JSON]: {
                    schema: jsonSchema(body, "input", `${at}.body`),
                  },
                },
              },
            }),
        responses: {
          ...declared,
          ...platformResponses(body !== undefined, ownBadRequest),
        },
      },
    };
  }

  if (problems.length > 0) throw new DomainConfigError(problems);

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title,
      version,
      ...describedBy(domain.description),
    },
    servers: [
      {
        url: `${SERVER_URL}${domain.name}`,
        variables: { environment: { default: DEFAULT_ENVIRONMENT } },
      },
    ],
    security: [{ [SECURITY_SCHEME]: [] }],
    paths,
    components: COMPONENTS,
  };
}
