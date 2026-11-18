import type { input, output, ZodObject, ZodType } from "zod";

import type { HandlerRejectionCode, RouteRejectionCode } from "./errors.ts";

// Generic types. Nothing in this section knows about domains or this SDK, so each could be
// promoted to a shared package once another workspace needs it. The openapi-rest driver already
// declares its own PathParameters, in gateways/drivers/openapi-rest/src/config/refine.ts.

// A required property named for the mistake. The compiler reports it missing, so the message
// reads as the rule that was broken, on the line that broke it.
type Problem<Message extends string> = {
  readonly [Text in Message]: never;
};

type IsNever<Type> = [Type] extends [never] ? true : false;

type IsSame<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

type HasField<Type, Field extends string> = Field extends keyof Type
  ? true
  : false;

// "push-tokens" as "PushTokens".
type PascalWords<Text extends string> =
  Text extends `${infer Word}-${infer Rest}`
    ? `${Capitalize<Word>}${PascalWords<Rest>}`
    : Capitalize<Text>;

// "id" and "linkId" from "DELETE /v1/todos/{id}/links/{linkId}".
export type PathParameters<Template extends string> =
  Template extends `${string}{${infer Param}}${infer Rest}`
    ? Param | PathParameters<Rest>
    : never;

// "DELETE" from "DELETE /v1/todos/{id}".
export type MethodOf<Request extends string> =
  Request extends `${infer Method} ${string}` ? Method : never;

export type SuccessStatusCode =
  200 | 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 226;

// The 2xx statuses the Fetch standard calls null body statuses: a response with one carries no
// body, and a `Response` built with one throws.
export type NullBodyStatusCode = 204 | 205;

// The domain's types.

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RouteKey = `${HttpMethod} /v${number}/${string}`;

type SegmentName<Segment extends string> = Segment extends `{${infer Param}}`
  ? `By${Capitalize<Param>}`
  : PascalWords<Segment>;

type SegmentsName<Path extends string> =
  Path extends `${infer Segment}/${infer Rest}`
    ? `${SegmentName<Segment>}${SegmentsName<Rest>}`
    : SegmentName<Path>;

/** The name a route key derives, such as `getV1TodosById` from `GET /v1/todos/{id}`. */
export type RouteName<Key extends string> =
  Key extends `${infer Method} /v${infer Version}/${infer Path}`
    ? `${Lowercase<Method>}V${Version}${SegmentsName<Path>}`
    : never;

/** A route key read into its parts. */
export interface ParsedRouteKey {
  readonly method: HttpMethod;
  readonly version: number;
  /** The path with its version, such as `/v1/todos/{id}`. */
  readonly path: string;
  readonly parameters: readonly string[];
  /** The OpenAPI `operationId`, and the name a route is logged by. */
  readonly name: string;
  // The key with every parameter's name blanked, so two keys that match the same requests
  // compare equal: `GET /v1/todos/{id}` and `GET /v1/todos/{todoId}` are one route.
  readonly shape: string;
}

export type RouteKeyResult =
  | { readonly ok: true; readonly route: ParsedRouteKey }
  | { readonly ok: false; readonly problems: readonly string[] };

export interface Caller {
  readonly pairwiseId: string;
}

export interface Rejection<
  Code extends RouteRejectionCode | HandlerRejectionCode,
> {
  readonly rejected: Code;
}

// Never a key a domain uses. They keep the empty slot below an interface, and carry the key a
// handler was typed for, without either existing at runtime.
declare const UNREGISTERED: unique symbol;
declare const ROUTE_KEY: unique symbol;

export interface RouteConfig {
  // Not a function type: checking a handler against one would read its signature, and so the
  // registered configuration, while the configuration's own type is still being worked out.
  // HandlerCheck holds it to the route's key instead.
  readonly handler: object;
  readonly params?: ZodObject;
  readonly query?: ZodObject;
  readonly body?: ZodType;
  readonly responses: {
    readonly [Status in SuccessStatusCode]?: ZodType | null;
  };
  readonly errors?: readonly RouteRejectionCode[];
}

export type DomainRoutes = Readonly<Record<string, RouteConfig>>;

export interface DomainConfig<Routes extends DomainRoutes = DomainRoutes> {
  readonly name: string;
  readonly routes: Routes;
}

/**
 * Where a domain registers its configuration, so a handler can be typed by its route's key:
 *
 * ```ts
 * declare module "@govuk-once/flex-domain-sdk" {
 *   interface Register {
 *     readonly domain: typeof domain;
 *   }
 * }
 * ```
 *
 * A domain's repository holds one domain, so it registers once. A second configuration in the same
 * program, such as one a test builds, cannot register too: its handlers are typed by the registered
 * routes and held only to its keys, so give it the registered routes' own schemas.
 */
export interface Register {
  readonly [UNREGISTERED]?: never;
}

// An empty record before a domain registers, so no key is accepted until then.
type RegisteredRoutes = Register extends {
  readonly domain: { readonly routes: infer Routes };
}
  ? Routes
  : Record<never, never>;

export type RegisteredRouteKey = Extract<keyof RegisteredRoutes, string>;

type RegisteredRoute<Key extends RegisteredRouteKey> = RegisteredRoutes[Key];

type RequestPart = "params" | "query" | "body";

// Requests read a schema's output, which validation produces.
type RequestOf<Route> = {
  readonly [Part in RequestPart & keyof Route]-?: Route[Part] extends ZodType
    ? output<Route[Part]>
    : never;
};

type ErrorCodesOf<Route> = Route extends {
  readonly errors: readonly (infer Code extends RouteRejectionCode)[];
}
  ? Code
  : never;

// What `reject()` accepts: the codes the route lists, and those any handler may answer with.
type RejectCodeOf<Route> = ErrorCodesOf<Route> | HandlerRejectionCode;

type ResponsesOf<Route> = Route extends { readonly responses: infer Responses }
  ? Responses
  : never;

// Responses write a schema's input, which validation reads. A `null` response has no body, and
// `body?: never` refuses one, which a returned object would otherwise let through, since it is
// not always checked for excess properties.
type ResponseOf<Route> = {
  [
    Status in keyof ResponsesOf<Route> & number
  ]: ResponsesOf<Route>[Status] extends ZodType
    ? {
        readonly status: Status;
        readonly body: input<ResponsesOf<Route>[Status]>;
      }
    : { readonly status: Status; readonly body?: never };
}[keyof ResponsesOf<Route> & number];

/** What a handler is called with for a route, given the route's configuration. */
export type RouteContextOf<Route> = {
  readonly caller: Caller;
  readonly reject: <Code extends RejectCodeOf<Route>>(
    code: Code,
  ) => Rejection<Code>;
} & RequestOf<Route>;

/** What a handler may answer with for a route, given the route's configuration. */
export type RouteResultOf<Route> =
  ResponseOf<Route> | Rejection<RejectCodeOf<Route>>;

/** What the handler of the registered route under `Key` is called with. */
export type RouteContext<Key extends RegisteredRouteKey> = RouteContextOf<
  RegisteredRoute<Key>
>;

export type RouteResult<Key extends RegisteredRouteKey> = RouteResultOf<
  RegisteredRoute<Key>
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

// Each check is `unknown` when the route passes it, so a route that passes them all is `unknown`.

type KeyCheck<Key extends string> = Key extends RouteKey
  ? unknown
  : Problem<"a route key is '<METHOD> /v<n>/<path>'">;

type UnknownFields<Route> = Exclude<keyof Route, keyof RouteConfig> & string;

type FieldCheck<Route> =
  IsNever<UnknownFields<Route>> extends true
    ? unknown
    : {
        readonly [
          Field in UnknownFields<Route>
        ]: Problem<`'${Field}' is not a route field`>;
      };

type ParamsShape<Route> = Route extends {
  readonly params: ZodObject<infer Shape>;
}
  ? Shape
  : never;

type ParamsKeys<Route> = keyof ParamsShape<Route> & string;

type MissingParams<Key extends string, Route> = Exclude<
  PathParameters<Key>,
  ParamsKeys<Route>
>;

type ExtraParams<Key extends string, Route> = Exclude<
  ParamsKeys<Route>,
  PathParameters<Key>
>;

// A path parameter always arrives as a string. A schema takes one when its input is a string, as
// `z.string()` and `z.enum()` have, or anything, as `z.coerce.number()` has. `z.number()` takes
// neither, so it would refuse every request.
type TakesString<Schema> = Schema extends ZodType
  ? unknown extends input<Schema>
    ? true
    : [input<Schema>] extends [string]
      ? true
      : false
  : false;

type NonStringParams<Route> = {
  [Param in ParamsKeys<Route>]: TakesString<
    ParamsShape<Route>[Param]
  > extends true
    ? never
    : Param;
}[ParamsKeys<Route>];

type ParamsInputCheck<Route> =
  IsNever<NonStringParams<Route>> extends true
    ? unknown
    : {
        readonly params: Problem<`path parameter '${NonStringParams<Route>}' arrives as a string, so its schema must take one, such as z.string() or z.coerce.number()`>;
      };

// A key with no parameter takes no params.
type NoParamsCheck<Route> =
  HasField<Route, "params"> extends true
    ? {
        readonly params: Problem<"the route key has no path parameter, so it takes no params">;
      }
    : unknown;

// A key with parameters takes params whose keys are exactly those parameters.
type ParamsMatchCheck<Key extends string, Route> =
  HasField<Route, "params"> extends false
    ? {
        readonly params: ZodObject<{
          [Param in PathParameters<Key>]: ZodType;
        }>;
      }
    : IsNever<MissingParams<Key, Route> | ExtraParams<Key, Route>> extends true
      ? ParamsInputCheck<Route>
      : {
          readonly params: Problem<
            | `path parameter '${MissingParams<Key, Route>}' is missing from params`
            | `params key '${ExtraParams<Key, Route>}' is not a path parameter`
          >;
        };

type ParamsCheck<Key extends string, Route> =
  IsNever<PathParameters<Key>> extends true
    ? NoParamsCheck<Route>
    : ParamsMatchCheck<Key, Route>;

type QueryShape<Route> = Route extends {
  readonly query: ZodObject<infer Shape>;
}
  ? Shape
  : never;

type QueryKeys<Route> = keyof QueryShape<Route> & string;

// What a query parameter arrives as that a schema's input takes: a string, or a list of strings
// when the parameter is repeated. A parameter left out arrives as nothing, so `undefined` in an
// input neither helps nor hurts.
type QueryValues<Input> = Input extends string
  ? Input
  : Input extends readonly (infer Item)[]
    ? unknown extends Item
      ? Input
      : [Item] extends [string]
        ? Input
        : never
    : never;

// Unlike a path parameter, a query parameter can be left out or repeated, so a schema is refused
// only when it can never take what arrives. `z.number()` takes neither a string nor a list.
type TakesQueryValue<Schema> = Schema extends ZodType
  ? unknown extends input<Schema>
    ? true
    : IsNever<QueryValues<input<Schema>>> extends true
      ? false
      : true
  : false;

type NonStringQuery<Route> = {
  [Param in QueryKeys<Route>]: TakesQueryValue<
    QueryShape<Route>[Param]
  > extends true
    ? never
    : Param;
}[QueryKeys<Route>];

type QueryCheck<Route> =
  IsNever<NonStringQuery<Route>> extends true
    ? unknown
    : {
        readonly query: Problem<`query parameter '${NonStringQuery<Route>}' arrives as a string, or a list of them when repeated, so its schema must take one, such as z.string() or z.coerce.number()`>;
      };

type BodyCheck<Key extends string, Route> =
  HasField<Route, "body"> extends true
    ? MethodOf<Key> extends "GET" | "DELETE"
      ? { readonly body: Problem<`a ${MethodOf<Key>} route takes no body`> }
      : unknown
    : unknown;

type StatusCodes<Route> = keyof ResponsesOf<Route>;

type FailureStatusCodes<Route> = Exclude<
  StatusCodes<Route>,
  SuccessStatusCode
> &
  number;

// The problem sits on `responses` itself, not on the status: `null & Problem` would reduce the
// whole object to `never` and lose the message.
type ResponsesCheck<Route> =
  IsNever<StatusCodes<Route>> extends true
    ? { readonly responses: Problem<"responses needs at least one status"> }
    : IsNever<FailureStatusCodes<Route>> extends true
      ? unknown
      : {
          readonly responses: Problem<`status ${FailureStatusCodes<Route>} is not 2xx: a failure is a code in errors`>;
        };

// A null body status declared with a schema, which would make its handler return a body that
// can never be sent: every request to it would fail.
type NullBodyStatusesWithSchema<Route> = {
  [
    Status in keyof ResponsesOf<Route> & NullBodyStatusCode
  ]: ResponsesOf<Route>[Status] extends null ? never : Status;
}[keyof ResponsesOf<Route> & NullBodyStatusCode];

type NullBodyCheck<Route> =
  IsNever<NullBodyStatusesWithSchema<Route>> extends true
    ? unknown
    : {
        readonly responses: Problem<`status ${NullBodyStatusesWithSchema<Route>} has no body, so its schema is null`>;
      };

type StructureCheck<Key extends string, Route> = KeyCheck<Key> &
  FieldCheck<Route> &
  ParamsCheck<Key, Route> &
  QueryCheck<Route> &
  BodyCheck<Key, Route> &
  ResponsesCheck<Route> &
  NullBodyCheck<Route>;

type HandlerKeyOf<Route> = Route extends {
  readonly handler: { readonly [ROUTE_KEY]?: infer Key };
}
  ? Key
  : never;

// Only the key the handler was typed for is compared, never its signature, which would need the
// registered configuration while its own type is still being worked out. The handler's body is
// checked against its route where it is written. Checked once the route itself is right, so a
// mistake in the route is reported once.
type HandlerCheck<Key extends string, Route> =
  unknown extends StructureCheck<Key, Route>
    ? IsSame<HandlerKeyOf<Route>, Key> extends true
      ? unknown
      : {
          readonly handler: Problem<`the handler must be typed Handler<"${Key}">`>;
        }
    : unknown;

type RefineRoute<Key extends string, Route> = StructureCheck<Key, Route> &
  HandlerCheck<Key, Route>;

export type RefinedRoutes<Routes extends DomainRoutes> = {
  readonly [Key in keyof Routes & string]: RefineRoute<Key, Routes[Key]>;
};
