import type { input, ZodObject, ZodType } from "zod";

import type { HandlerKeyOf } from "./handler.ts";
import type {
  NullBodyStatusCode,
  RESPONSE_STATUS_CODES,
  ResponseStatusCode,
} from "./http.ts";
import type {
  DomainRoutes,
  HasField,
  IsNever,
  IsSame,
  Join,
  MethodOf,
  PathParameters,
  Problem,
  ResponsesOf,
  RouteConfig,
  RouteKey,
  StatusCodesOf,
} from "./types.ts";

// Each check is `unknown` when the route passes it, so a route that passes them all is `unknown`.

type KeyCheck<Key extends string> = Key extends RouteKey
  ? unknown
  : Problem<'invalid route key, must be "<METHOD> /<version>/<path>"'>;

type UnknownFields<Route> = Exclude<keyof Route, keyof RouteConfig> & string;

type FieldCheck<Route> =
  IsNever<UnknownFields<Route>> extends true
    ? unknown
    : {
        readonly [
          Field in UnknownFields<Route>
        ]: Problem<`unknown field "${Field}", must be one of: handler, params, query, body, responses`>;
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

type Scalar = string | number | boolean;

// The SDK reads a parameter's text by the type its schema declares, so the schema's input is
// that type. A schema whose input is `unknown`, as a coerced one's is, would take the text as it
// is and convert it loosely, so it is refused.
type TakesScalar<Input> = unknown extends Input
  ? false
  : [Input] extends [Scalar]
    ? true
    : false;

type NonStringParams<Route> = {
  [Param in ShapeKeys<Route, "params">]: TakesScalar<
    InputOf<Route, "params", Param>
  > extends true
    ? never
    : Param;
}[ShapeKeys<Route, "params">];

type ParamsInputCheck<Route> =
  IsNever<NonStringParams<Route>> extends true
    ? unknown
    : {
        readonly params: Problem<`invalid path parameter {${NonStringParams<Route>}}, must be a string, number, boolean or enum, not optional or converted`>;
      };

// A key with no parameter takes no params.
type NoParamsCheck<Route> =
  HasField<Route, "params"> extends true
    ? {
        readonly params: Problem<"params not allowed, the route key has no path parameters">;
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
            | `missing params key, required by path parameter {${MissingParams<Key, Route>}}`
            | `unknown params key "${ExtraParams<Key, Route>}", not a path parameter`
          >;
        };

type ParamsCheck<Key extends string, Route> =
  IsNever<PathParameters<Key>> extends true
    ? NoParamsCheck<Route>
    : ParamsMatchCheck<Key, Route>;

// A query parameter may be left out, so `undefined` in its input is allowed, and may be repeated,
// so a list of one type is too.
type TakesQueryValue<Input> = unknown extends Input
  ? false
  : TakesScalar<Exclude<Input, undefined>> extends true
    ? true
    : [Exclude<Input, undefined>] extends [readonly (infer Item)[]]
      ? TakesScalar<Item>
      : false;

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
        readonly query: Problem<`invalid query parameter "${NonStringQuery<Route>}", must be a string, number, boolean, enum or an array of one, not converted`>;
      };

type BodyCheck<Key extends string, Route> =
  HasField<Route, "body"> extends true
    ? MethodOf<Key> extends "GET" | "DELETE"
      ? {
          readonly body: Problem<`body not allowed, a ${MethodOf<Key>} route takes no body`>;
        }
      : unknown
    : unknown;

type RefusedStatusCodes<Route> = Exclude<
  keyof ResponsesOf<Route>,
  ResponseStatusCode
> &
  number;

// One message for each refused status, distributed over them.
type StatusProblem<Status extends number> = Status extends 401 | 403
  ? `status ${Status} not allowed, the app treats it as an expired token`
  : `${Status}` extends `5${string}`
    ? `status ${Status} not allowed, any handler may return 500, 502, 503 or 504 undeclared`
    : `status ${Status} not allowed, must be one of: ${Join<typeof RESPONSE_STATUS_CODES, ", ">}`;

// The problem sits on `responses` itself, not on the status: `null & Problem` would reduce the
// whole object to `never` and lose the message.
type ResponsesCheck<Route> =
  IsNever<keyof ResponsesOf<Route>> extends true
    ? {
        readonly responses: Problem<"responses empty, declare at least one status">;
      }
    : IsNever<RefusedStatusCodes<Route>> extends true
      ? unknown
      : {
          readonly responses: Problem<StatusProblem<RefusedStatusCodes<Route>>>;
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
        readonly responses: Problem<`status ${NullBodyStatusesWithSchema<Route>} must be null, a ${NullBodyStatusesWithSchema<Route>} response has no body`>;
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
          readonly handler: Problem<`handler typed for another route, must be Handler<"${Key}">`>;
        }
    : unknown;

type RefineRoute<Key extends string, Route> = StructureCheck<Key, Route> &
  HandlerCheck<Key, Route>;

export type RefinedRoutes<Routes extends DomainRoutes> = {
  readonly [Key in keyof Routes & string]: RefineRoute<Key, Routes[Key]>;
};
