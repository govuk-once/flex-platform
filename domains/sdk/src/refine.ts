import type { input, ZodObject, ZodType } from "zod";

import type { HandlerKeyOf } from "./handler.ts";
import type { NullBodyStatusCode, SuccessStatusCode } from "./http.ts";
import type {
  HasField,
  IsNever,
  IsSame,
  PathParameters,
  Problem,
} from "./type-utils.ts";
import type {
  DomainRoutes,
  MethodOf,
  ResponsesOf,
  RouteConfig,
  RouteKey,
  StatusCodesOf,
} from "./types.ts";

// Each check is `unknown` when the route passes it, so a route that passes them all is `unknown`.

type KeyCheck<Key extends string> = Key extends RouteKey
  ? unknown
  : Problem<'a route key must have the format "<METHOD> /<version>/<path>"'>;

type UnknownFields<Route> = Exclude<keyof Route, keyof RouteConfig> & string;

type FieldCheck<Route> =
  IsNever<UnknownFields<Route>> extends true
    ? unknown
    : {
        readonly [
          Field in UnknownFields<Route>
        ]: Problem<`"${Field}" is not a route field; accepted fields: handler, params, query, body, responses, errors`>;
      };

// The fields a route's `params` or `query` object declares, each with its schema, and none when
// the route has no such object.
type ShapeOf<Route, Part extends "params" | "query"> = Route extends {
  readonly [Field in Part]: ZodObject<infer Shape>;
}
  ? Shape
  : Record<never, never>;

type ShapeKeys<Route, Part extends "params" | "query"> = keyof ShapeOf<
  Route,
  Part
> &
  string;

type InputOf<Route, Part extends "params" | "query", Field> = input<
  ShapeOf<Route, Part>[Field & keyof ShapeOf<Route, Part>]
>;

type MissingParams<Key extends string, Route> = Exclude<
  PathParameters<Key>,
  ShapeKeys<Route, "params">
>;

type ExtraParams<Key extends string, Route> = Exclude<
  ShapeKeys<Route, "params">,
  PathParameters<Key>
>;

// A path parameter always arrives as a string. A schema takes one when its input is a string, as
// `z.string()` and `z.enum()` have, or anything, as `z.coerce.number()` has. `z.number()` takes
// neither, so it would refuse every request.
type TakesString<Input> = unknown extends Input
  ? true
  : [Input] extends [string]
    ? true
    : false;

type NonStringParams<Route> = {
  [Param in ShapeKeys<Route, "params">]: TakesString<
    InputOf<Route, "params", Param>
  > extends true
    ? never
    : Param;
}[ShapeKeys<Route, "params">];

type ParamsInputCheck<Route> =
  IsNever<NonStringParams<Route>> extends true
    ? unknown
    : {
        readonly params: Problem<`path parameter {${NonStringParams<Route>}} arrives as a string, so its schema must take one, such as z.string() or z.coerce.number()`>;
      };

// A key with no parameter takes no params.
type NoParamsCheck<Route> =
  HasField<Route, "params"> extends true
    ? {
        readonly params: Problem<"params must be left out, as the route key has no path parameter">;
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
            | `params is missing the key for the path parameter {${MissingParams<Key, Route>}}`
            | `params key "${ExtraParams<Key, Route>}" is not a path parameter`
          >;
        };

type ParamsCheck<Key extends string, Route> =
  IsNever<PathParameters<Key>> extends true
    ? NoParamsCheck<Route>
    : ParamsMatchCheck<Key, Route>;

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
type TakesQueryValue<Input> = unknown extends Input
  ? true
  : IsNever<QueryValues<Input>> extends true
    ? false
    : true;

type NonStringQuery<Route> = {
  [Param in ShapeKeys<Route, "query">]: TakesQueryValue<
    InputOf<Route, "query", Param>
  > extends true
    ? never
    : Param;
}[ShapeKeys<Route, "query">];

type QueryCheck<Route> =
  IsNever<NonStringQuery<Route>> extends true
    ? unknown
    : {
        readonly query: Problem<`query parameter "${NonStringQuery<Route>}" arrives as a string, or a list of them when repeated, so its schema must take one, such as z.string() or z.coerce.number()`>;
      };

type BodyCheck<Key extends string, Route> =
  HasField<Route, "body"> extends true
    ? MethodOf<Key> extends "GET" | "DELETE"
      ? {
          readonly body: Problem<`body must be left out, as a ${MethodOf<Key>} route takes no body`>;
        }
      : unknown
    : unknown;

type FailureStatusCodes<Route> = Exclude<
  keyof ResponsesOf<Route>,
  SuccessStatusCode
> &
  number;

// The problem sits on `responses` itself, not on the status: `null & Problem` would reduce the
// whole object to `never` and lose the message.
type ResponsesCheck<Route> =
  IsNever<keyof ResponsesOf<Route>> extends true
    ? {
        readonly responses: Problem<"responses must declare at least one status">;
      }
    : IsNever<FailureStatusCodes<Route>> extends true
      ? unknown
      : {
          readonly responses: Problem<`status ${FailureStatusCodes<Route>} is not a success status; accepted statuses: 2xx, with a failure as a code in errors`>;
        };

// A null body status declared with a schema, which would make its handler return a body that
// can never be sent: every request to it would fail.
type NullBodyStatusesWithSchema<Route> = {
  [
    Status in StatusCodesOf<Route> & NullBodyStatusCode
  ]: ResponsesOf<Route>[Status] extends null ? never : Status;
}[StatusCodesOf<Route> & NullBodyStatusCode];

type NullBodyCheck<Route> =
  IsNever<NullBodyStatusesWithSchema<Route>> extends true
    ? unknown
    : {
        readonly responses: Problem<`the schema for status ${NullBodyStatusesWithSchema<Route>} must be null, as a response with that status has no body`>;
      };

type StructureCheck<Key extends string, Route> = KeyCheck<Key> &
  FieldCheck<Route> &
  ParamsCheck<Key, Route> &
  QueryCheck<Route> &
  BodyCheck<Key, Route> &
  ResponsesCheck<Route> &
  NullBodyCheck<Route>;

type RouteHandlerKey<Route> = Route extends { readonly handler: infer Value }
  ? HandlerKeyOf<Value>
  : never;

// Only the key the handler was typed for is compared, never its signature, which would need the
// registered configuration while its own type is still being worked out. The handler's body is
// checked against its route where it is written. Checked once the route itself is right, so a
// mistake in the route is reported once.
type HandlerCheck<Key extends string, Route> =
  unknown extends StructureCheck<Key, Route>
    ? IsSame<RouteHandlerKey<Route>, Key> extends true
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
