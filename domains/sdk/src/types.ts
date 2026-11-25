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
  readonly pattern: string;
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

// A required property named for the mistake. The compiler reports it missing, so the message
// reads as the rule that was broken, on the line that broke it.
export type Problem<Message extends string> = {
  readonly [Text in Message]: never;
};

export type IsNever<Type> = [Type] extends [never] ? true : false;

export type IsSame<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

export type HasField<Type, Field extends string> = Field extends keyof Type
  ? true
  : false;

// "id" and "linkId" from "/v1/todos/{id}/links/{linkId}".
export type PathParameters<Template extends string> =
  Template extends `${string}{${infer Param}}${infer Rest}`
    ? Param | PathParameters<Rest>
    : never;

// "200, 201" from [200, 201] and ", ".
export type Join<
  Items extends readonly (string | number)[],
  Separator extends string,
> = Items extends readonly [
  infer First extends string | number,
  ...infer Rest extends readonly (string | number)[],
]
  ? Rest extends readonly []
    ? `${First}`
    : `${First}${Separator}${Join<Rest, Separator>}`
  : "";
