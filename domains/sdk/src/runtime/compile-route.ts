// A route's configuration read once, as the function loads, into what each request needs. The
// configuration has passed checkDomain, so a problem here is a bug in the SDK, and throws.

import type { Routable } from "@repo/utils/route-matcher";
import type { ZodObject, ZodType } from "zod";

import type { ParameterLocation } from "../input-rules.ts";
import { parameterTypes } from "../input-rules.ts";
import { parseRouteKey } from "../route-key.ts";
import type { RouteConfig } from "../types.ts";
import type { ReadParameters, SentParameters } from "./parameter-reader.ts";
import { createParameterReader } from "./parameter-reader.ts";
import type { ResponseSchemas } from "./result.ts";
import { responseSchemas } from "./result.ts";

export interface CompiledParameters {
  readonly schema: ZodObject;
  readonly read: (sent: SentParameters) => ReadParameters;
}

// A handler as the runtime calls it. Its own type is held to its route by the configuration's
// types.
type RouteHandler = (context: object) => unknown;

// The configuration types a handler as `object` (see RouteConfig), and checkDomain has refused
// anything but a function, so this only narrows what is already true.
function isRouteHandler(value: object): value is RouteHandler {
  return typeof value === "function";
}

export interface CompiledRoute extends Routable {
  readonly key: string;
  readonly handler: RouteHandler;
  readonly params?: CompiledParameters;
  readonly query?: CompiledParameters;
  readonly body?: ZodType;
  readonly responses: ResponseSchemas;
}

function compileParameters(
  schema: ZodObject | undefined,
  location: ParameterLocation,
  key: string,
): CompiledParameters | undefined {
  if (schema === undefined) return undefined;

  const result = parameterTypes(schema, location);

  if (!result.ok) {
    throw new TypeError(
      `routes[${JSON.stringify(key)}]: failed to read ${location} parameters`,
    );
  }

  return { schema, read: createParameterReader(result.types) };
}

export function compileRoute(key: string, route: RouteConfig): CompiledRoute {
  const parsed = parseRouteKey(key);

  if (!parsed.ok) {
    throw new TypeError(`routes[${JSON.stringify(key)}]: invalid route key`);
  }

  const { handler, params, query, body, responses } = route;

  if (!isRouteHandler(handler)) {
    throw new TypeError(
      `routes[${JSON.stringify(key)}]: handler is not a function`,
    );
  }

  const compiledParams = compileParameters(params, "path", key);
  const compiledQuery = compileParameters(query, "query", key);

  return {
    key,
    method: parsed.route.method,
    path: key.slice(key.indexOf(" ") + 1),
    handler,
    ...(compiledParams === undefined ? {} : { params: compiledParams }),
    ...(compiledQuery === undefined ? {} : { query: compiledQuery }),
    ...(body === undefined ? {} : { body }),
    responses: responseSchemas(responses),
  };
}
