// The types a route's key and declaration give its handler: the context it is called with and
// the result it may return. Each is built from the configuration's literal types, so a handler
// that reads a header or a parameter the route does not declare fails to compile, and so does
// one that answers with a status the route does not declare.

import type { z, ZodType } from "zod";

import type { Caller } from "./caller.ts";
import type {
  DomainConfig,
  HeaderDeclarations,
  RouteDeclaration,
} from "./config.ts";
import type {
  Failure,
  PlatformFailureCode,
  RouteFailureCode,
} from "./errors.ts";
import type { HttpMethod, RouteRequest, RouteResponse } from "./http.ts";
import type { Log } from "./logging/logger.ts";

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

/** Every route the configuration declares, as `METHOD /version/path`. */
export type RouteKey<Config extends DomainConfig> = {
  [Version in keyof Config["routes"] & string]: {
    [Path in keyof Config["routes"][Version] & string]: {
      [
        Method in keyof Config["routes"][Version][Path] & HttpMethod
      ]: `${Method} /${Version}${Path}`;
    }[keyof Config["routes"][Version][Path] & HttpMethod];
  }[keyof Config["routes"][Version] & string];
}[keyof Config["routes"] & string];

type Segments<Key extends string> =
  Key extends `${infer Method extends HttpMethod} /${infer Version}/${infer Path}`
    ? { method: Method; version: Version; path: `/${Path}` }
    : never;

/** The declaration under a key in the configuration. */
export type DeclarationOf<Config extends DomainConfig, Key extends string> =
  Segments<Key> extends {
    method: infer Method extends string;
    version: infer Version extends string;
    path: infer Path extends string;
  }
    ? Version extends keyof Config["routes"]
      ? Path extends keyof Config["routes"][Version]
        ? Method extends keyof Config["routes"][Version][Path]
          ? Config["routes"][Version][Path][Method]
          : never
        : never
      : never
    : never;

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

type NoHeaders = Record<never, never>;

type CommonHeaders<Config extends DomainConfig> = Config extends {
  readonly common: {
    readonly headers: infer Headers extends HeaderDeclarations;
  };
}
  ? Headers
  : NoHeaders;

type RouteHeaders<Declaration> = Declaration extends {
  readonly headers: infer Headers extends HeaderDeclarations;
}
  ? Headers
  : NoHeaders;

type MergedHeaders<Config extends DomainConfig, Declaration> = Omit<
  CommonHeaders<Config>,
  keyof RouteHeaders<Declaration>
> &
  RouteHeaders<Declaration>;

type ResolvedHeaders<Headers> = {
  readonly [Alias in keyof Headers]: Headers[Alias] extends {
    readonly required: false;
  }
    ? string | undefined
    : string;
};

type WithHeaders<
  Config extends DomainConfig,
  Declaration,
> = keyof MergedHeaders<Config, Declaration> extends never
  ? unknown
  : { readonly headers: ResolvedHeaders<MergedHeaders<Config, Declaration>> };

type WithParams<Declaration> = Declaration extends {
  readonly params: infer Schema extends ZodType;
}
  ? { readonly params: z.output<Schema> }
  : unknown;

type WithQuery<Declaration> = Declaration extends {
  readonly query: infer Schema extends ZodType;
}
  ? { readonly query: z.output<Schema> }
  : unknown;

type WithBody<Declaration> = Declaration extends {
  readonly body: infer Schema extends ZodType;
}
  ? { readonly body: z.output<Schema> }
  : unknown;

type DeclaredFailures<Declaration> = Declaration extends {
  readonly errors: readonly (infer Code extends RouteFailureCode)[];
}
  ? Code
  : never;

type WithFail<Declaration> = [DeclaredFailures<Declaration>] extends [never]
  ? unknown
  : {
      /** A failure the route declares, to return in place of a response. */
      readonly fail: <Code extends DeclaredFailures<Declaration>>(
        code: Code,
      ) => Failure<Code>;
    };

export interface BaseContext {
  readonly caller: Caller;
  readonly log: Log;
  /** The request's correlation id, when it came with one. Echoed on the response. */
  readonly correlationId: string | undefined;
  /** Aborts when the request's deadline passes. */
  readonly signal: AbortSignal;
}

export type RouteContextOf<
  Config extends DomainConfig,
  Declaration,
> = BaseContext &
  WithHeaders<Config, Declaration> &
  WithParams<Declaration> &
  WithQuery<Declaration> &
  WithBody<Declaration> &
  WithFail<Declaration>;

/** What the handler of the route under `Key` is called with. */
export type RouteContext<
  Config extends DomainConfig,
  Key extends string,
> = RouteContextOf<Config, DeclarationOf<Config, Key>>;

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

type DeclaredResponses<Declaration> = Declaration extends {
  readonly responses: infer Responses;
}
  ? {
      [Status in keyof Responses & number]: Responses[Status] extends ZodType
        ? { readonly status: Status; readonly body: z.input<Responses[Status]> }
        : { readonly status: Status; readonly body?: undefined };
    }[keyof Responses & number]
  : never;

/** What the handler of a route may answer with: a declared response, or a failure. */
export type RouteResultOf<Declaration> =
  | DeclaredResponses<Declaration>
  | Failure<PlatformFailureCode>
  | Failure<DeclaredFailures<Declaration>>;

export type RouteResult<
  Config extends DomainConfig,
  Key extends string,
> = RouteResultOf<DeclarationOf<Config, Key>>;

/** A response as a handler returns it, before the route validates and serialises it. */
export interface HandlerResponse {
  readonly status: number;
  readonly body?: unknown;
}

export type Handler<Config extends DomainConfig, Key extends string> = (
  context: RouteContext<Config, Key>,
) => RouteResult<Config, Key> | Promise<RouteResult<Config, Key>>;

// ---------------------------------------------------------------------------------------------
// What route() returns
// ---------------------------------------------------------------------------------------------

/**
 * A route with its handler: what the function's entry point mounts. `run` takes a matched request
 * through validation, the handler and response validation, and never throws.
 */
export interface RouteHandler<Key extends string = string> {
  readonly key: Key;
  readonly method: HttpMethod;
  /** The path with its version, such as `/v1/todos/:id`. */
  readonly path: string;
  run(request: RouteRequest): Promise<RouteResponse>;
}

export interface RouteFactory<Config extends DomainConfig> {
  // The result is a type parameter of its own, marked const, so a handler's `{ status: 204 }`
  // keeps its literal status and is held to the responses the route declares. Typed as the
  // handler's return directly, the status would widen to number before it was checked.
  <
    const Key extends RouteKey<Config>,
    const Result extends RouteResult<Config, Key>,
  >(
    key: Key,
    handler: (context: RouteContext<Config, Key>) => Result | Promise<Result>,
  ): RouteHandler<Key>;
}

export interface RouteContextReader<Config extends DomainConfig> {
  /** The context of the request being handled, for a module the handler calls. */
  <Key extends RouteKey<Config> = never>(): [Key] extends [never]
    ? 'Name the route, so the context is typed: routeContext<"GET /v1/todos/:id">()'
    : RouteContext<Config, Key>;
}

export type { RouteDeclaration };
