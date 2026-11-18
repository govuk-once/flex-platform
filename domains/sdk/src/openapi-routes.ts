// Each route as the definition @hono/zod-openapi takes, which the domain's server registers, so
// Hono checks a request against the route's schemas before its handler runs. Internal: a domain
// declares its routes once, in its configuration, and never writes or registers one of these.
//
// A route's responses are every answer it can give: its success statuses, the codes it lists, the
// codes any handler may reject with, and the codes the pipeline answers with before its handler
// runs.

import type { RouteConfig as OpenApiRouteConfig } from "@hono/zod-openapi";
import { createRoute } from "@hono/zod-openapi";
import { heldValue } from "@repo/utils/held-value";
import type { ZodType } from "zod";

import { DomainConfigError } from "./check-domain.ts";
import type { ErrorCode } from "./errors.ts";
import { ErrorBodySchema, ERRORS, HANDLER_REJECTION_CODES } from "./errors.ts";
import { parseRouteKey } from "./route-key.ts";
import type {
  DomainConfig,
  DomainRoutes,
  HttpMethod,
  ParsedRouteKey,
  RouteConfig,
  SuccessStatusCode,
} from "./types.ts";

type OpenApiRoutes<Routes extends DomainRoutes> = {
  readonly [Key in keyof Routes & string]: OpenApiRouteConfig;
};

const METHODS: Readonly<
  Record<HttpMethod, "get" | "post" | "put" | "patch" | "delete">
> = {
  GET: "get",
  POST: "post",
  PUT: "put",
  PATCH: "patch",
  DELETE: "delete",
};

// OpenAPI requires every response to have a description. These are the statuses' reason phrases.
const SUCCESS_DESCRIPTIONS: Readonly<Record<SuccessStatusCode, string>> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-authoritative information",
  204: "No content",
  205: "Reset content",
  206: "Partial content",
  207: "Multi-status",
  208: "Already reported",
  226: "IM used",
};

const DESCRIPTIONS: ReadonlyMap<string, string> = new Map(
  Object.entries(SUCCESS_DESCRIPTIONS),
);

function jsonContent(schema: ZodType) {
  return { "application/json": { schema } };
}

function parsedKey(key: string): ParsedRouteKey {
  const result = parseRouteKey(key);

  if (!result.ok) {
    throw new DomainConfigError(
      result.problems.map(
        (problem) => `routes[${JSON.stringify(key)}]: ${problem}`,
      ),
    );
  }

  return result.route;
}

// A route that takes input can fail its schemas, and one that takes a body can be sent it as
// something other than JSON. Every request can arrive without a caller.
function errorCodes(route: RouteConfig): readonly ErrorCode[] {
  const { params, query, body } = route;

  const takesInput =
    params !== undefined || query !== undefined || body !== undefined;

  return [
    "unauthorized",
    ...(takesInput ? (["invalid_request"] as const) : []),
    ...(body === undefined ? [] : (["unsupported_media_type"] as const)),
    ...(route.errors ?? []),
    ...HANDLER_REJECTION_CODES,
  ];
}

// Each code has its own status, so no failure replaces another.
function responses(route: RouteConfig): OpenApiRouteConfig["responses"] {
  const result: OpenApiRouteConfig["responses"] = {};

  for (const [status, schema] of Object.entries(route.responses)) {
    const description = heldValue(DESCRIPTIONS, status);

    result[status] =
      schema === null || schema === undefined
        ? { description }
        : { description, content: jsonContent(schema) };
  }

  for (const code of errorCodes(route)) {
    const { status, message } = ERRORS[code];

    result[String(status)] = {
      description: message,
      content: jsonContent(ErrorBodySchema),
    };
  }

  return result;
}

function openApiRoute(key: string, route: RouteConfig): OpenApiRouteConfig {
  const { method, path, name } = parsedKey(key);

  const { params, query, body } = route;

  return createRoute({
    method: METHODS[method],
    path,
    operationId: name,
    request: {
      ...(params === undefined ? {} : { params }),
      ...(query === undefined ? {} : { query }),
      ...(body === undefined
        ? {}
        : { body: { required: true, content: jsonContent(body) } }),
    },
    responses: responses(route),
  });
}

/**
 * Each route's definition for `app.openapi()`, by its key. The path stays in OpenAPI's form, such
 * as `/v1/todos/{id}`, which the library turns into Hono's.
 */
export function openApiRoutes<Routes extends DomainRoutes>(
  domain: DomainConfig<Routes>,
): OpenApiRoutes<Routes> {
  return Object.fromEntries(
    Object.entries(domain.routes).map(([key, route]) => [
      key,
      openApiRoute(key, route),
    ]),
  ) as OpenApiRoutes<Routes>;
}
