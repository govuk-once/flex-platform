import type { input, output, ZodType } from "zod";

import type { ServerErrorStatusCode } from "./http.ts";
import type { RegisteredRouteKey, RegisteredRoutes } from "./register.ts";
import type { ResponsesOf, StatusCodesOf } from "./types.ts";

// Never a key a domain uses. It carries the key a handler was typed for, without existing at
// runtime.
declare const ROUTE_KEY: unique symbol;

type RequestPart = "params" | "query" | "body";

// Requests read a schema's output, which validation produces.
type RequestOf<Route> = {
  readonly [Part in RequestPart & keyof Route]-?: Route[Part] extends ZodType
    ? output<Route[Part]>
    : never;
};

// Responses write a schema's input, which validation reads. A `null` response has no body, and
// `body?: never` refuses one, which a returned object would otherwise let through, since it is
// not always checked for excess properties.
type ResponseOf<Route> = {
  [Status in StatusCodesOf<Route>]: ResponsesOf<Route>[Status] extends ZodType
    ? {
        readonly status: Status;
        readonly body: input<ResponsesOf<Route>[Status]>;
      }
    : { readonly status: Status; readonly body?: never };
}[StatusCodesOf<Route>];

// A failure that is not the route's own. It has no body of the handler's.
interface ServerError {
  readonly status: ServerErrorStatusCode;
  readonly body?: never;
}

/** What a handler is called with for a route, given the route's configuration. */
export type RouteContextOf<Route> = RequestOf<Route>;

/**
 * What a handler may answer with for a route: one of the responses it declares, a failure
 * included, or a server error, which no route declares.
 */
export type RouteResultOf<Route> = ResponseOf<Route> | ServerError;

/** What the handler of the registered route under `Key` is called with. */
export type RouteContext<Key extends RegisteredRouteKey> = RouteContextOf<
  RegisteredRoutes[Key]
>;

export type RouteResult<Key extends RegisteredRouteKey> = RouteResultOf<
  RegisteredRoutes[Key]
>;

// The route is looked up through Register, not taken as a type argument, because a handler typed
// by `typeof domain` would make the configuration's type depend on its own handlers. The lookup is
// lazy, so the configuration's type is complete before any handler reads it.
/**
 * A route's handler. Annotate the constant with it:
 *
 * ```ts
 * export const getTodo: Handler<"GET /v1/todos/{id}"> = ({ params }) => ...
 * ```
 *
 * `satisfies Handler<...>` makes the constant's type depend on the configuration, which depends on
 * the handler, and the compiler reports that as circular references inside this package's types.
 * A handler with no annotation has untyped parameters, and the configuration refuses it.
 */
export type Handler<Key extends RegisteredRouteKey> = ((
  context: RouteContext<Key>,
) => RouteResult<Key> | Promise<RouteResult<Key>>) & {
  readonly [ROUTE_KEY]?: Key;
};

/** The key a handler was typed for, read without its signature. */
export type HandlerKeyOf<Value> = Value extends {
  readonly [ROUTE_KEY]?: infer Key;
}
  ? Key
  : never;
