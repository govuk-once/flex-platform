// A route's configuration read once, as the function loads, into what each request needs. The
// configuration has passed checkDomain, so a problem here is a bug in the SDK, and throws.

import type { Routable } from "@repo/utils/route-matcher";
import type { ZodObject, ZodType } from "zod";

import type { ParameterLocation } from "../input-rules.ts";
import { parameterTypes } from "../input-rules.ts";
import { parseRouteKey } from "../route-key.ts";
import type { RouteConfig } from "../types.ts";
import type { ResultRules } from "./handler-result.ts";
import { resultRules } from "./handler-result.ts";
import type { ReadParameters, SentParameters } from "./parameter-reader.ts";
import { createParameterReader } from "./parameter-reader.ts";
import type { CompiledPath } from "./pick-fields.ts";
import { compilePaths } from "./pick-fields.ts";

export interface CompiledParameters {
  readonly schema: ZodObject;
  readonly read: (sent: SentParameters) => ReadParameters;
}

export interface CompiledRoute extends Routable {
  readonly key: string;
  readonly handler: (context: object) => unknown;
  readonly params?: CompiledParameters;
  readonly query?: CompiledParameters;
  readonly body?: ZodType;
  readonly results: ResultRules;
  readonly logInput: readonly CompiledPath[];
  readonly logOutput: readonly CompiledPath[];
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
      `routes[${JSON.stringify(key)}]: unreadable ${location} parameters`,
    );
  }

  return { schema, read: createParameterReader(result.types) };
}

export function compileRoute(key: string, route: RouteConfig): CompiledRoute {
  const parsed = parseRouteKey(key);

  if (!parsed.ok) {
    throw new TypeError(`routes[${JSON.stringify(key)}]: invalid route key`);
  }

  const { handler, params, query, body, responses, log } = route;

  const compiledParams = compileParameters(params, "path", key);
  const compiledQuery = compileParameters(query, "query", key);

  return {
    key,
    method: parsed.route.method,
    path: key.slice(key.indexOf(" ") + 1),
    handler: handler as (context: object) => unknown,
    ...(compiledParams === undefined ? {} : { params: compiledParams }),
    ...(compiledQuery === undefined ? {} : { query: compiledQuery }),
    ...(body === undefined ? {} : { body }),
    results: resultRules(responses),
    logInput: compilePaths(log?.input),
    logOutput: compilePaths(log?.output),
  };
}
