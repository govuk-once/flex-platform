import type { ZodObject, ZodType } from "zod";

import type { HttpMethod, ResponseStatusCode } from "./http.ts";

export type RouteKey = `${HttpMethod} /v${number}/${string}`;

// "DELETE" from "DELETE /v1/todos/{id}".
export type MethodOf<Key extends string> =
  Key extends `${infer Method} ${string}` ? Method : never;

/** A route key read into its parts. */
export interface ParsedRouteKey {
  readonly method: HttpMethod;
  readonly parameters: readonly string[];
  // The key with every parameter's name blanked, so two keys that match the same requests
  // compare equal: `GET /v1/todos/{id}` and `GET /v1/todos/{todoId}` are one route.
  readonly shape: string;
}

export type RouteKeyResult =
  | { readonly ok: true; readonly route: ParsedRouteKey }
  | { readonly ok: false; readonly problems: readonly string[] };

export interface RouteConfig {
  // Not a function type: checking a handler against one would read its signature, and so the
  // registered configuration, while the configuration's own type is still being worked out.
  // HandlerCheck holds it to the route's key instead.
  readonly handler: object;
  readonly params?: ZodObject;
  readonly query?: ZodObject;
  readonly body?: ZodType;
  readonly responses: {
    readonly [Status in ResponseStatusCode]?: ZodType | null;
  };
}

export type DomainRoutes = Readonly<Record<string, RouteConfig>>;

export interface DomainConfig<Routes extends DomainRoutes = DomainRoutes> {
  readonly name: string;
  readonly routes: Routes;
}

export type ResponsesOf<Route> = Route extends {
  readonly responses: infer Responses;
}
  ? Responses
  : never;

export type StatusCodesOf<Route> = keyof ResponsesOf<Route> & number;
