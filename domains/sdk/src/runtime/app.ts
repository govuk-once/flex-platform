// A domain's requests, answered: the caller is read, the route found, its inputs read and
// validated, its handler run, and what it returned checked against the route. Reading the inputs,
// the handler and the check each race the deadline, and a handler is never called once it has
// passed. The first step that answers ends the request. Nothing throws out of `fetch`: an
// unexpected error is a 500. The caller token is read before routing, as a gateway and the
// Frontdoor read it, so a request without one learns nothing of the routes.
//
// Every request gets exactly one line from the SDK, at the level its outcome gives: `info` for an
// answer the route declares, `warn` for a refusal or a failure the SDK understands, and `error`
// only for the domain's code being wrong: its handler, or a schema that throws. The line names
// which, by its subject. The line holds fixed text and values the configuration or the platform
// set. Never a value from a request, a response or an error's message.

import type { InvocationFailure } from "@govuk-once/flex-gateway-client";
import { GatewayInvocationError } from "@govuk-once/flex-gateway-client";
import { withCallerContext } from "@govuk-once/flex-gateway-client/caller";
import { isJsonContentType } from "@repo/cloudfront-js-utils/is-json-content-type";
import { describeUnexpectedError } from "@repo/utils/describe-unexpected-error";
import { routeMatcher } from "@repo/utils/route-matcher";
import type { Logger } from "pino";
import type { ZodType } from "zod";

import { checkDomain } from "../check-domain.ts";
import type { Caller } from "../handler.ts";
import type { ServerErrorStatusCode } from "../http.ts";
import { CALLER_TOKEN_HEADER, CORRELATION_ID_HEADER } from "../http.ts";
import type { DomainConfig } from "../types.ts";
import { readCallerToken } from "./caller-token.ts";
import type { CompiledRoute } from "./compile-route.ts";
import { compileRoute } from "./compile-route.ts";
import type { DeadlineOutcome } from "./deadline.ts";
import { ANSWER_MARGIN_MS, runBeforeDeadline } from "./deadline.ts";
import type { LineFields, LogLevel } from "./logging.ts";
import {
  createLogger,
  createRequestLogger,
  requestFields,
  withCallerValues,
} from "./logging.ts";
import { parseJson, pathParameters, queryParameters } from "./request-input.ts";
import type { PlatformErrorStatus } from "./responses.ts";
import { refusalResponse } from "./responses.ts";
import { responseFor } from "./result.ts";
import { runSchema } from "./run-schema.ts";

export interface FetchOptions {
  readonly remainingTimeMs: number;
}

export interface App {
  fetch(request: Request, options: FetchOptions): Promise<Response>;
}

export interface CreateAppOptions {
  readonly logger?: Logger;
}

const TRACE_ID = /^1-[0-9a-f]{8}-[0-9a-f]{24}$/;

interface Outcome {
  readonly level: LogLevel;
  readonly message: string;
  readonly response: Response;
  readonly fields?: LineFields;
}

// What answered the request, and the route that took it, once one did.
interface Responded {
  readonly outcome: Outcome;
  readonly routeKey?: string;
}

type Input = Readonly<Record<string, unknown>>;

// A part of the request, read: under its name when the route declares it, or what answers the
// request instead, a refusal or its schema's failure.
type ReadPart =
  | { readonly ok: true; readonly input: Input }
  | { readonly ok: false; readonly outcome: Outcome };

type RequestPart = "query" | "params" | "body";

const NOTHING_READ: ReadPart = { ok: true, input: {} };

function refusal(
  status: PlatformErrorStatus,
  message: string,
  fields: LineFields = {},
  headers: HeadersInit = {},
): Outcome {
  return {
    level: "warn",
    message,
    response: refusalResponse(status, headers),
    fields,
  };
}

// A refusal is the request's mistake. A failure is code that threw, logged by where it was thrown,
// never by what it says.
function failure(
  message: string,
  error: unknown,
  fields: LineFields = {},
): Outcome {
  return {
    ...refusal(500, message, {
      ...fields,
      frames: describeUnexpectedError(error).frames,
    }),
    level: "error",
  };
}

function refusedPart(
  part: RequestPart,
  reason: string,
  status: PlatformErrorStatus = 400,
): ReadPart {
  return { ok: false, outcome: refusal(status, `${part}: refused, ${reason}`) };
}

function traceIdOf(request: Request): string | undefined {
  const sent = request.headers.get(CORRELATION_ID_HEADER);

  if (sent === null || !TRACE_ID.test(sent)) return undefined;

  return sent;
}

async function validatedPart(
  part: RequestPart,
  schema: ZodType,
  value: unknown,
): Promise<ReadPart> {
  const result = await runSchema(schema, value);

  if (result.kind === "failed") {
    return {
      ok: false,
      outcome: failure(`${part}: failed, its schema threw`, result.error),
    };
  }

  if (result.kind === "refused") {
    return refusedPart(part, "rejected by its schema");
  }

  return { ok: true, input: { [part]: result.data } };
}

// A query on a route without one is refused rather than ignored, so a route can declare one later
// without changing what an existing request means. A body is held to the same rule.
async function readQuery(route: CompiledRoute, url: URL): Promise<ReadPart> {
  const { query } = route;

  if (query === undefined) {
    return url.search === ""
      ? NOTHING_READ
      : refusedPart("query", "not declared by the route");
  }

  return validatedPart(
    "query",
    query.schema,
    query.read(queryParameters(url.searchParams)),
  );
}

async function readParams(
  route: CompiledRoute,
  matched: ReadonlyMap<string, string>,
): Promise<ReadPart> {
  const { params } = route;

  if (params === undefined) return NOTHING_READ;

  const decoded = pathParameters(matched);

  if (decoded === undefined) {
    return refusedPart("params", "does not decode to one segment");
  }

  return validatedPart("params", params.schema, params.read(decoded));
}

async function readBody(
  route: CompiledRoute,
  request: Request,
): Promise<ReadPart> {
  const { body } = route;

  const text = await request.text();

  if (body === undefined) {
    return text === ""
      ? NOTHING_READ
      : refusedPart("body", "not declared by the route");
  }

  if (text === "") return refusedPart("body", "missing");

  const contentType = request.headers.get("content-type") ?? undefined;

  if (!isJsonContentType(contentType)) {
    return refusedPart("body", "content type is not JSON", 415);
  }

  const json = parseJson(text);

  if (!json.ok) return refusedPart("body", json.reason);

  return validatedPart("body", body, json.value);
}

async function readInput(
  route: CompiledRoute,
  request: Request,
  url: URL,
  matched: ReadonlyMap<string, string>,
): Promise<ReadPart> {
  const query = await readQuery(route, url);

  if (!query.ok) return query;

  const params = await readParams(route, matched);

  if (!params.ok) return params;

  const body = await readBody(route, request);

  if (!body.ok) return body;

  return {
    ok: true,
    input: { ...query.input, ...params.input, ...body.input },
  };
}

interface HandlerContext {
  readonly caller: Caller;
  readonly token: string;
  readonly deadline: number;
  readonly log: Logger;
}

// The handler's own failures are caught around it alone, so a response schema that throws is
// never taken for the handler's.
async function runHandler(
  route: CompiledRoute,
  input: Input,
  { caller, token, deadline, log }: HandlerContext,
): Promise<Outcome> {
  let settled: DeadlineOutcome<unknown>;

  try {
    settled = await runBeforeDeadline(deadline, (signal) =>
      withCallerContext({ deadline, secure: { token } }, () =>
        withCallerValues([token, caller.pairwiseId, caller.pushId], () =>
          route.handler({ ...input, caller, signal, log }),
        ),
      ),
    );
  } catch (error: unknown) {
    if (
      error instanceof GatewayInvocationError &&
      Object.hasOwn(INVOCATION_FAILURE_STATUSES, error.reason)
    ) {
      return refusal(
        INVOCATION_FAILURE_STATUSES[error.reason],
        "gateway: call failed, uncaught by the handler",
        { reason: error.reason },
      );
    }

    return failure("handler: threw an unexpected error", error);
  }

  if (settled.timedOut) {
    return refusal(504, "handler: passed the request's deadline");
  }

  const result = settled.value;

  const responded = await runBeforeDeadline(deadline, () =>
    responseFor(route.responses, result),
  );

  if (responded.timedOut) {
    return refusal(504, "response: passed the request's deadline");
  }

  const checked = responded.value;

  if (checked.kind === "failed") {
    return failure("response: failed, its schema threw", checked.error);
  }

  if (checked.kind === "problem") {
    return {
      ...refusal(500, "handler: returned a result its route does not allow", {
        problem: checked.problem,
      }),
      level: "error",
    };
  }

  const { response, serverError } = checked;

  if (serverError) {
    return {
      level: "warn",
      message: "handler: returned a server error",
      response,
    };
  }

  return {
    level: "info",
    message: "request: answered by its route",
    response,
  };
}

function logOutcome(
  logger: Logger,
  { level, message, fields = {} }: Outcome,
  lineFields: LineFields,
): void {
  try {
    logger[level]({ ...lineFields, ...fields }, message);
  } catch {
    // The response is sent whatever becomes of its log line.
  }
}

// The answer to a gateway call that did not answer, which a handler let through. The client's
// deadline is the request's, so a call that ran out of time is the request's timeout. A function
// that failed, or answered with something other than a response, is the gateway's fault. A call
// Lambda refused, or one the handler abandoned, is the domain's own.
const INVOCATION_FAILURE_STATUSES: Readonly<
  Record<InvocationFailure, ServerErrorStatusCode>
> = {
  timed_out: 504,
  function_error: 502,
  invalid_response: 502,
  invoke_failed: 500,
  aborted: 500,
};

// An error nothing else answered for: a failure of the SDK itself, since the domain's code, its
// schemas and its handler, is caught where it runs.
function sdkFailure(error: unknown): Outcome {
  return failure("sdk: failed while answering the request", error);
}

function passedBeforeHandler(): Outcome {
  return refusal(504, "request: passed its deadline before its handler ran");
}

/**
 * Answers a domain's requests. The configuration is checked and its routes compiled now, as the
 * function loads, so one that never passed through defineDomain is refused all the same.
 */
export function createApp(
  domain: DomainConfig,
  { logger = createLogger(domain.name) }: CreateAppOptions = {},
): App {
  checkDomain(domain);

  const routes = Object.entries(domain.routes).map(([key, route]) =>
    compileRoute(key, route),
  );

  const matchRoute = routeMatcher(routes);

  async function respond(
    request: Request,
    traceId: string | undefined,
    deadline: number,
  ): Promise<Responded> {
    const callerToken = readCallerToken(
      request.headers.get(CALLER_TOKEN_HEADER),
    );

    if (callerToken === undefined) {
      return { outcome: refusal(500, "caller: failed to read caller token") };
    }

    const { caller, token } = callerToken;

    const url = new URL(request.url);

    const matched = matchRoute(request.method, url.pathname);

    if (matched.kind === "none") {
      return { outcome: refusal(404, "route: none matches the path") };
    }

    if (matched.kind === "method") {
      const allow = { allow: matched.allowed.join(", ") };

      return {
        outcome: refusal(
          405,
          "route: none for the method on this path",
          {},
          allow,
        ),
      };
    }

    const { route, params } = matched;

    const routeKey = route.key;

    // Caught here as well as in `fetch`, so a failure once a route is found keeps the route on its
    // line.
    try {
      const reading = await runBeforeDeadline(deadline, () =>
        readInput(route, request, url, params),
      );

      if (reading.timedOut) return { outcome: passedBeforeHandler(), routeKey };

      const read = reading.value;

      if (!read.ok) return { outcome: read.outcome, routeKey };

      // The input can be read in time with none left, and a handler is never called after it.
      if (Date.now() >= deadline) {
        return { outcome: passedBeforeHandler(), routeKey };
      }

      const outcome = await runHandler(route, read.input, {
        caller,
        token,
        deadline,
        log: createRequestLogger(logger, requestFields(traceId, routeKey)),
      });

      return { outcome, routeKey };
    } catch (error: unknown) {
      return { outcome: sdkFailure(error), routeKey };
    }
  }

  return {
    async fetch(request, { remainingTimeMs }) {
      const started = Date.now();

      // Taken as the request arrives, as `remainingTimeMs` was measured, so the time spent reading
      // the request counts against it once.
      const deadline = started + remainingTimeMs - ANSWER_MARGIN_MS;

      const traceId = traceIdOf(request);

      let responded: Responded;

      try {
        responded = await respond(request, traceId, deadline);
      } catch (error: unknown) {
        responded = { outcome: sdkFailure(error) };
      }

      const { outcome, routeKey } = responded;

      const { response } = outcome;

      if (traceId !== undefined) {
        response.headers.set(CORRELATION_ID_HEADER, traceId);
      }

      logOutcome(logger, outcome, {
        ...requestFields(traceId, routeKey),
        status: response.status,
        durationMs: Date.now() - started,
      });

      return response;
    },
  };
}
