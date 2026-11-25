// A domain's requests, answered: the caller is read, the route found, its inputs read and
// validated, its handler run before the deadline, and what it answered checked against the route.
// The first step that answers ends the request. Nothing throws out of `serve`: an unexpected error
// is a 500. The caller token is read before routing, as a gateway and the Frontdoor read it, so a
// request without one learns nothing of the routes.
//
// Every request gets exactly one line from the SDK, at the level its outcome gives: `info` for an
// answer the route declares, `warn` for a refusal or a failure the SDK understands, and `error`
// only for a handler whose code is wrong. The line holds fixed text and values the configuration
// or the platform set, plus what the route's `log` names. Never a value from a request, a
// response or an error's message.

import type { InvocationFailure } from "@govuk-once/flex-gateway-client";
import { GatewayInvocationError } from "@govuk-once/flex-gateway-client";
import { withCallerContext } from "@govuk-once/flex-gateway-client/caller";
import { isJsonContentType } from "@repo/cloudfront-js-utils/is-json-content-type";
import { describeUnexpectedError } from "@repo/utils/describe-unexpected-error";
import { routeMatcher } from "@repo/utils/route-matcher";

import { checkDomain } from "../check-domain.ts";
import type { ServerErrorStatusCode } from "../http.ts";
import { CALLER_TOKEN_HEADER, CORRELATION_ID_HEADER } from "../http.ts";
import type { DomainConfig } from "../types.ts";
import { readCallerToken } from "./caller-token.ts";
import type { CompiledRoute } from "./compile-route.ts";
import { compileRoute } from "./compile-route.ts";
import { ANSWER_MARGIN_MS, runBeforeDeadline } from "./deadline.ts";
import { answerResult } from "./handler-result.ts";
import type {
  CallerValueGuard,
  LogEntry,
  LogLevel,
  LogSink,
} from "./log-writer.ts";
import { callerValueGuard, handlerLog, pinoSink } from "./log-writer.ts";
import { pickFields } from "./pick-fields.ts";
import { parseJson, pathParameters, queryParameters } from "./request-input.ts";
import type { PlatformErrorStatus } from "./responses.ts";
import { refusalResponse } from "./responses.ts";

export interface ServeOptions {
  /** How long the invocation has left, as Lambda's context reports it. */
  readonly remainingTimeMs: number;
}

export type Serve = (
  request: Request,
  options: ServeOptions,
) => Promise<Response>;

export interface CreateServeOptions {
  /** Where the lines go. Standard output, in the format the gateways write, by default. */
  readonly sink?: LogSink;
}

// The Frontdoor's form, `1-<8 hex>-<24 hex>`. Anything else is the caller's, and is not repeated.
const TRACE_ID = /^1-[0-9a-f]{8}-[0-9a-f]{24}$/;

interface Answer {
  readonly level: LogLevel;
  readonly message: string;
  readonly response: Response;
  readonly fields?: LogEntry;
}

function refused(
  status: PlatformErrorStatus,
  message: string,
  fields: LogEntry = {},
  headers: HeadersInit = {},
): Answer {
  return {
    level: "warn",
    message,
    response: refusalResponse(status, headers),
    fields,
  };
}

function invalidInput(part: "query" | "params" | "body"): Answer {
  return refused(400, "request refused", { part });
}

// The handler's inputs, each part the route declares and nothing else, or the refusal.
async function readInput(
  route: CompiledRoute,
  request: Request,
  url: URL,
  params: ReadonlyMap<string, string>,
): Promise<{ readonly input: Record<string, unknown> } | Answer> {
  const input: Record<string, unknown> = {};

  const text = await request.text();

  if (route.query === undefined) {
    // Refused rather than ignored, so a route can declare a query later without changing what an
    // existing request means. The same holds for a body below.
    if (url.search !== "") return invalidInput("query");
  } else {
    const { schema, read } = route.query;

    const parsed = schema.safeParse(read(queryParameters(url.searchParams)));

    if (!parsed.success) return invalidInput("query");

    input["query"] = parsed.data;
  }

  if (route.params !== undefined) {
    const { schema, read } = route.params;

    const sent = pathParameters(params);

    const parsed =
      sent === undefined ? undefined : schema.safeParse(read(sent));

    if (parsed?.success !== true) return invalidInput("params");

    input["params"] = parsed.data;
  }

  if (route.body === undefined) {
    if (text !== "") return invalidInput("body");
  } else {
    if (text === "") return invalidInput("body");

    const contentType = request.headers.get("content-type") ?? undefined;

    if (!isJsonContentType(contentType)) {
      return refused(415, "request refused", { part: "body" });
    }

    const json = parseJson(text);

    const parsed = json.ok ? route.body.safeParse(json.value) : undefined;

    if (parsed?.success !== true) return invalidInput("body");

    input["body"] = parsed.data;
  }

  return { input };
}

async function runHandler(
  route: CompiledRoute,
  input: Record<string, unknown>,
  context: {
    readonly caller: object;
    readonly token: string;
    readonly remainingTimeMs: number;
    readonly log: object;
  },
): Promise<Answer> {
  const { caller, token, remainingTimeMs, log } = context;

  const deadline = Date.now() + remainingTimeMs - ANSWER_MARGIN_MS;

  const picked =
    route.logInput.length > 0
      ? { input: pickFields(input, route.logInput) }
      : {};

  try {
    const outcome = await runBeforeDeadline(deadline, (signal) =>
      withCallerContext({ deadline, secure: { token } }, () =>
        route.handler({ ...input, caller, signal, log }),
      ),
    );

    if (outcome.timedOut) {
      return refused(504, "handler passed the request's deadline", picked);
    }

    const answer = answerResult(route.results, outcome.value);

    if (!answer.ok) {
      return {
        ...refused(
          500,
          "handler answered with something its route does not allow",
          { ...picked, problem: answer.problem },
        ),
        level: "error",
      };
    }

    const { response, output, serverError } = answer;

    const outputFields =
      output !== undefined && route.logOutput.length > 0
        ? { output: pickFields(output, route.logOutput) }
        : {};

    return {
      level: serverError ? "warn" : "info",
      message: serverError
        ? "handler answered with a server error"
        : "request answered",
      response,
      fields: { ...picked, ...outputFields },
    };
  } catch (error: unknown) {
    if (
      error instanceof GatewayInvocationError &&
      Object.hasOwn(INVOCATION_FAILURE_STATUSES, error.reason)
    ) {
      return refused(
        INVOCATION_FAILURE_STATUSES[error.reason],
        "gateway call failed",
        {
          ...picked,
          reason: error.reason,
        },
      );
    }

    return {
      ...refused(500, "handler threw", {
        ...picked,
        frames: describeUnexpectedError(error).frames,
      }),
      level: "error",
    };
  }
}

function writeLine(
  sink: LogSink,
  guard: CallerValueGuard,
  { level, message, fields = {} }: Answer,
  line: LogEntry,
): void {
  const { fields: safe, replaced } = guard({ ...line, ...fields });

  const raised = replaced.length > 0 && level === "info" ? "warn" : level;

  try {
    sink.write(
      raised,
      message,
      replaced.length > 0 ? { ...safe, replaced } : safe,
    );
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

/**
 * Answers a domain's requests. The configuration is checked and its routes compiled now, as the
 * function loads, so one that never passed through defineDomain is refused all the same.
 */
export function createServe(
  domain: DomainConfig,
  { sink = pinoSink(domain.name) }: CreateServeOptions = {},
): Serve {
  checkDomain(domain);

  const routes = Object.entries(domain.routes).map(([key, route]) =>
    compileRoute(key, route),
  );

  const match = routeMatcher(routes);

  return async (request, { remainingTimeMs }) => {
    const started = Date.now();

    const sentTraceId = request.headers.get(CORRELATION_ID_HEADER);

    const traceId =
      sentTraceId !== null && TRACE_ID.test(sentTraceId)
        ? sentTraceId
        : undefined;

    const line: Record<string, unknown> =
      traceId === undefined ? {} : { traceId };

    let guard = callerValueGuard([]);

    const answer = async (): Promise<Answer> => {
      const callerToken = readCallerToken(
        request.headers.get(CALLER_TOKEN_HEADER),
      );

      if (callerToken === undefined) {
        return refused(500, "request has no readable caller token");
      }

      const { caller, token } = callerToken;

      guard = callerValueGuard([token, caller.pairwiseId, caller.pushId]);

      const url = new URL(request.url);

      const found = match(request.method, url.pathname);

      if (found.kind === "none") return refused(404, "no route for the path");

      if (found.kind === "method") {
        return refused(
          405,
          "no route for the method",
          {},
          { allow: found.allowed.join(", ") },
        );
      }

      const { route, params } = found;

      line["route"] = route.key;

      const read = await readInput(route, request, url, params);

      if (!("input" in read)) return read;

      const log = handlerLog(sink, { ...line }, guard);

      return runHandler(route, read.input, {
        caller,
        token,
        remainingTimeMs,
        log,
      });
    };

    let result: Answer;

    try {
      result = await answer();
    } catch (error: unknown) {
      result = {
        ...refused(500, "request failed in the SDK", {
          frames: describeUnexpectedError(error).frames,
        }),
        level: "error",
      };
    }

    const { response } = result;

    if (traceId !== undefined)
      response.headers.set(CORRELATION_ID_HEADER, traceId);

    writeLine(sink, guard, result, {
      ...line,
      status: response.status,
      durationMs: Date.now() - started,
    });

    return response;
  };
}
