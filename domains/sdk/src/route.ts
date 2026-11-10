// The route factory and the pipeline a request goes through once the router has matched it.
// Each step owns the status it answers, and nothing throws out of `run`: every failure leaves as
// a response. The order follows the gateway's: the caller, the content type, the request's parts
// in a fixed order, the handler raced against the deadline, then the response against its
// schema. The body sent is the schema's output, not the handler's value, so a field the contract
// does not declare never leaves.

import { GatewayInvocationError } from "@govuk-once/flex-gateway-client";
import { withCallerContext } from "@govuk-once/flex-gateway-client/caller";
import { ownValue } from "@repo/utils/own-value";
import type { ZodType } from "zod";

import type { CallerIdentity } from "./caller.ts";
import { readCaller } from "./caller.ts";
import type {
  DomainConfig,
  HeaderDeclarations,
  RouteDeclaration,
} from "./config.ts";
import { currentRequest, requestStorage } from "./context.ts";
import type { FailureCode } from "./errors.ts";
import {
  errorBody,
  Failure,
  fromInvocationFailure,
  PLATFORM_FAILURE_CODES,
  statusOf,
} from "./errors.ts";
import type { HttpMethod, RouteRequest, RouteResponse } from "./http.ts";
import {
  CONTENT_TYPE_HEADER,
  CORRELATION_HEADER,
  HTTP_METHODS,
  JSON_MEDIA_TYPE,
  lowerCaseHeaders,
  mediaType,
  TRACE_HEADER,
  traceRoot,
} from "./http.ts";
import type { Logger } from "./logging/logger.ts";
import type {
  BaseContext,
  HandlerResponse,
  RouteContextReader,
  RouteFactory,
  RouteHandler,
} from "./types.ts";

/**
 * How long before the function is stopped a route stops waiting for its handler, so there is
 * time to answer. The deadline the gateway client is given is this much earlier too.
 */
export const ANSWER_MARGIN_MS = 1000;

interface RouteKeySegments {
  readonly method: HttpMethod;
  readonly version: string;
  readonly path: string;
}

function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

/** The parts of a key such as `GET /v1/todos/:id`. The types hold a key to this form. */
export function parseRouteKey(key: string): RouteKeySegments {
  const [method, target, ...rest] = key.split(" ");
  const [, version, ...segments] = target?.split("/") ?? [];
  if (
    method === undefined ||
    !isHttpMethod(method) ||
    rest.length > 0 ||
    target?.startsWith("/") !== true ||
    version === undefined ||
    version === "" ||
    segments.length === 0 ||
    segments.includes("")
  ) {
    throw new Error(
      `A route's key is "METHOD /version/path", and ${JSON.stringify(key)} is not.`,
    );
  }
  return { method, version, path: `/${segments.join("/")}` };
}

type Validated<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false };

function parseWith(schema: ZodType, value: unknown): Validated<unknown> {
  const result = schema.safeParse(value);
  return result.success ? { ok: true, value: result.data } : { ok: false };
}

// Headers by alias, with each required one present. A required header that is missing fails the
// request; an optional one is undefined.
function resolveHeaders(
  declarations: HeaderDeclarations,
  headers: Readonly<Record<string, string>>,
): Validated<Record<string, string | undefined>> {
  const resolved: Record<string, string | undefined> = {};
  for (const [alias, { name, required }] of Object.entries(declarations)) {
    const value = headers[name.toLowerCase()];
    if (value === undefined && required !== false) return { ok: false };
    resolved[alias] = value;
  }
  return { ok: true, value: resolved };
}

function parseJson(text: string): Validated<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// The body's text, or undefined for a value JSON cannot write: `undefined` itself, a BigInt, or
// an object that holds itself.
function toJson(value: unknown): string | undefined {
  try {
    const text: unknown = JSON.stringify(value);
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

// The longest a timer can be set for. Past it, `setTimeout` fires at once and
// `AbortSignal.timeout` throws, so a deadline further off than this is waited for this long.
const MAX_TIMER_MS = 2 ** 31 - 1;

function remaining(deadline: number): number {
  return Math.min(MAX_TIMER_MS, Math.max(0, deadline - Date.now()));
}

const TIMED_OUT: unique symbol = Symbol("timed out");

// The handler's result, or the sentinel if the deadline passes first. The handler's work is not
// stopped: the signal in its context fires, and the gateway client refuses any call after the
// deadline, so what it still does cannot reach a gateway. A handler that fails once the deadline
// has passed, as one does when it wires the signal into its own work, timed out all the same.
async function raceDeadline<T>(
  run: () => Promise<T> | T,
  deadline: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), remaining(deadline));
  });
  try {
    return await Promise.race([Promise.resolve().then(run), timeout]);
  } catch (error) {
    if (Date.now() >= deadline) return TIMED_OUT;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isHandlerResponse(value: unknown): value is HandlerResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { status?: unknown }).status === "number"
  );
}

// What every step of one request answers and logs with.
interface Exchange {
  readonly headers: Readonly<Record<string, string>>;
  readonly correlationId: string | undefined;
  readonly log: Logger;
  readonly respond: (status: number, body: string) => RouteResponse;
  readonly failWith: (code: FailureCode) => RouteResponse;
}

export function createRouteFactory<const Config extends DomainConfig>(
  config: Config,
  logger: Logger,
): RouteFactory<Config> {
  return (key, handler) => {
    const { method, version, path } = parseRouteKey(key);
    const declaration: RouteDeclaration | undefined = ownValue(
      config.routes,
      version,
    )?.[path]?.[method];
    if (declaration === undefined) {
      throw new Error(
        `The configuration declares no route ${JSON.stringify(key)}.`,
      );
    }

    const headerDeclarations: HeaderDeclarations = {
      ...config.common?.headers,
      ...declaration.headers,
    };
    const hasHeaders = Object.keys(headerDeclarations).length > 0;
    // A Map, since the status comes from the handler at request time.
    const responses = new Map<number, ZodType | null>(
      Object.entries(declaration.responses).map(([status, schema]) => [
        Number(status),
        schema,
      ]),
    );
    const declaredFailures = new Set<FailureCode>(declaration.errors ?? []);
    // The codes a handler's failure is answered with as given: the route's own, and the
    // platform's. `unauthorized` and `unsupported_media_type` are neither, since only the route
    // decides them, so a handler cannot answer with one.
    const answerable = new Set<FailureCode>([
      ...PLATFORM_FAILURE_CODES,
      ...declaredFailures,
    ]);

    const open = (request: RouteRequest): Exchange => {
      const headers = lowerCaseHeaders(request.headers);
      const correlationId = headers[CORRELATION_HEADER];
      const log = logger.child({
        route: key,
        ...(correlationId !== undefined && { correlationId }),
        ...(request.requestId !== undefined && {
          requestId: request.requestId,
        }),
        ...(traceRoot(headers[TRACE_HEADER]) !== undefined && {
          traceId: traceRoot(headers[TRACE_HEADER]),
        }),
      });

      const respond = (
        status: number,
        body: string,
        extra: Readonly<Record<string, string>> = {},
      ): RouteResponse => ({
        status,
        headers: {
          ...(body !== "" && { [CONTENT_TYPE_HEADER]: JSON_MEDIA_TYPE }),
          ...(correlationId !== undefined && {
            [CORRELATION_HEADER]: correlationId,
          }),
          ...extra,
        },
        body,
      });
      const failWith = (code: FailureCode): RouteResponse =>
        respond(statusOf(code), JSON.stringify(errorBody(code)));
      return { headers, correlationId, log, respond, failWith };
    };

    const answer = async (
      request: RouteRequest,
      { headers, correlationId, log, respond, failWith }: Exchange,
    ): Promise<RouteResponse> => {
      if (!Number.isFinite(request.deadline)) {
        log.error("request has no deadline");
        return failWith("internal");
      }

      const identity: CallerIdentity | undefined = readCaller(headers);
      if (identity === undefined) {
        log.warn("caller token missing or unreadable");
        return failWith("unauthorized");
      }

      if (
        declaration.body !== undefined &&
        mediaType(headers[CONTENT_TYPE_HEADER]) !== JSON_MEDIA_TYPE
      ) {
        log.warn("request body is not JSON", { part: "content-type" });
        return failWith("unsupported_media_type");
      }

      const invalid = (part: string): RouteResponse => {
        log.warn("request validation failed", { part });
        return failWith("invalid_request");
      };

      const parts: Record<string, unknown> = {};
      if (declaration.params !== undefined) {
        const params = parseWith(declaration.params, request.params);
        if (!params.ok) return invalid("params");
        parts["params"] = params.value;
      }
      if (declaration.query !== undefined) {
        const query = parseWith(declaration.query, request.query);
        if (!query.ok) return invalid("query");
        parts["query"] = query.value;
      }
      if (hasHeaders) {
        const resolved = resolveHeaders(headerDeclarations, headers);
        if (!resolved.ok) return invalid("headers");
        parts["headers"] = resolved.value;
      }
      if (declaration.body !== undefined) {
        const json = parseJson(request.body ?? "");
        if (!json.ok) return invalid("body");
        const body = parseWith(declaration.body, json.value);
        if (!body.ok) return invalid("body");
        parts["body"] = body.value;
      }

      const deadline = request.deadline - ANSWER_MARGIN_MS;
      const base: BaseContext = {
        caller: identity.caller,
        log,
        correlationId,
        signal: AbortSignal.timeout(remaining(deadline)),
      };
      const context = {
        ...base,
        ...parts,
        ...(declaredFailures.size > 0 && {
          fail: (code: FailureCode) => new Failure(code),
        }),
      };

      let result: unknown;
      try {
        result = await withCallerContext(
          { deadline, secure: identity.secure },
          () =>
            requestStorage.run({ log, caller: identity.caller, context }, () =>
              raceDeadline(
                () =>
                  (handler as (context: unknown) => unknown)(context) as
                    HandlerResponse | Failure,
                deadline,
              ),
            ),
        );
      } catch (error) {
        if (error instanceof Failure) {
          result = error;
        } else if (error instanceof GatewayInvocationError) {
          log.warn("gateway call failed", { reason: error.reason });
          result = fromInvocationFailure(error.reason);
        } else {
          // As it was thrown: the logger reduces it to where it was created.
          log.error("handler failed", { error });
          return failWith("internal");
        }
      }

      if (result === TIMED_OUT) {
        log.error("handler did not answer before the deadline");
        return failWith("timeout");
      }

      if (result instanceof Failure) {
        const { code } = result as Failure;
        if (!answerable.has(code)) {
          log.error("handler failed with a code the route does not declare", {
            code,
          });
          return failWith("internal");
        }
        return failWith(code);
      }

      if (!isHandlerResponse(result)) {
        log.error("handler returned something that is not a response");
        return failWith("internal");
      }

      const schema = responses.get(result.status);
      if (schema === undefined) {
        log.error("handler answered with a status the route does not declare", {
          status: result.status,
        });
        return failWith("internal");
      }
      if (schema === null) {
        if (result.body !== undefined) {
          log.error("handler answered with a body for a status that has none", {
            status: result.status,
          });
          return failWith("internal");
        }
        return respond(result.status, "");
      }
      const validated = schema.safeParse(result.body);
      if (!validated.success) {
        log.error("response validation failed", {
          status: result.status,
          issues: validated.error.issues.map((issue) => issue.code),
        });
        return failWith("internal");
      }
      const text = toJson(validated.data);
      if (text === undefined) {
        log.error("response body cannot be written as JSON", {
          status: result.status,
        });
        return failWith("internal");
      }
      return respond(result.status, text);
    };

    // The steps above answer for every failure they expect. This answers for the rest, such as
    // a schema whose refinement or transform throws, so that nothing leaves `run` but a response.
    const run = async (request: RouteRequest): Promise<RouteResponse> => {
      const exchange = open(request);
      try {
        return await answer(request, exchange);
      } catch (error) {
        exchange.log.error("route failed", { error });
        return exchange.failWith("internal");
      }
    };

    const route: RouteHandler<typeof key> = {
      key,
      method,
      path: `/${version}${path}`,
      run,
    };
    return route;
  };
}

export function createRouteContextReader<
  Config extends DomainConfig,
>(): RouteContextReader<Config> {
  return (() => currentRequest().context) as RouteContextReader<Config>;
}
