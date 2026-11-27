---
title: Requests
description: How the domain SDK answers a request, in order, what it answers itself, and what it logs.
---

The [domain SDK](/flex-platform/domains/overview/#domain-sdk) answers each request to a domain from
its [configuration](/flex-platform/domains/configuration/).

:::caution[Planned]
The SDK does not yet export anything a domain's function can serve requests with. Serving them
from the function, behind its
[API's proxy integration](/flex-platform/domains/hosting/#routing-a-request), is planned. Until then, no deployed domain's request passes through the steps on this page. Only
the SDK's own tests run them.
:::

## A request, in order

The SDK takes each request through the steps below, in order. The first step that answers ends the
request. Nothing a handler or a schema throws escapes: the SDK answers any error that nothing else
answers with a 500.

1. **The caller.** The SDK reads `pairwiseId` and `pushId` from the
   [caller token](/flex-platform/frontdoor/caller-token/) in `x-flex-secure`. It does not verify
   the token, because API Gateway admits only requests the Frontdoor signed, and a gateway verifies
   the token on every call. The Frontdoor sends a token on every request. So if a request has no
   readable token, the platform is at fault, and the SDK answers with a 500. It does this before
   routing, so the request learns nothing of the routes.
2. **The route.** See [Routing](#routing). If no route has the path, the SDK answers with a 404.
   If a route has the path but not the method, the SDK answers with a 405. The 405 has an `Allow`
   header naming the methods the route does take.
3. **The query.** A route without `query` refuses any query string. Otherwise the SDK
   [reads each parameter from its text](/flex-platform/domains/configuration/#path-and-query-fields),
   and the route's `query` schema validates the result.
4. **The path parameters.** The SDK decodes each one once. It refuses a parameter that doesn't
   decode, or that decodes to text holding a `/`, because that would name a path of its own. It then
   reads each from its text, and the route's `params` schema validates the result.
5. **The body.** A route without `body` refuses a body that is not empty. A route with `body`
   refuses:
   - a request with no body;
   - a `content-type` other than `application/json`, with a 415. Parameters such as `charset` are
     allowed;
   - text that is not JSON;
   - JSON nested more than 64 objects or arrays deep;
   - JSON holding a `__proto__` key at any depth;
   - JSON its `body` schema refuses.

   The SDK reads every object in the body without a prototype. So the schema finds a field only
   where the request set it, never one such as `toString` that every object inherits.
6. **The handler.** The SDK calls the handler with its [context](#the-handlers-context), inside the
   gateway client's [caller context](/flex-platform/domains/overview/#the-caller-context). It waits
   for the handler until the [deadline](#the-deadline).
7. **The result.** The SDK holds what the handler returned to the route's
   [responses](#what-a-handler-returns), and sends it.

Steps 3 to 5 answer with a 400 for anything else they refuse. So a handler never sees input its
schemas refuse.

Schemas run with Zod's `safeParseAsync`, so a refinement or transform may be `async`. Input schemas
run before the handler, outside its caller context. So the client refuses a gateway call made from
an input schema.

## Routing

The SDK matches a request's method and path to a [route key](/flex-platform/domains/configuration/#route-keys).
A path matches a key if:

- it has as many segments as the key;
- each literal segment is equal once decoded, case and all;
- each parameter's segment is not empty.

So `/v1/todos/` and `/v1/Todos` match no route, and `/v1/%74odos` matches `/v1/todos`. A query
string plays no part.

Two keys can match one request, such as `GET /v1/todos/{id}` and `GET /v1/todos/archived`. At the
first segment where the two differ, the key with a literal segment takes the request. This holds
wherever either key is declared. An encoded spelling of the literal, such as `/v1/todos/%61rchived`,
counts as the literal too, so `{id}` is never `archived`.

The SDK matches the path the domain's API passes on, after the Frontdoor
[removes the domain's segment](/flex-platform/frontdoor/lambda-edge/#routing).

## The deadline

The deadline bounds how long the SDK spends on a request. The SDK sets it once, as the request
arrives. It is the time the invocation has left, less 500 milliseconds kept back to answer in.

Reading the input, the handler and the response's schema each run until the deadline. If any of
them passes it, the SDK answers with a 504. The SDK never calls a handler once the deadline has
passed.

If the deadline passes while the handler runs, the handler's `signal` aborts. The SDK does not stop
the handler's work. But the gateway client has the same deadline, so it refuses a call made after
the deadline before sending it, and abandons one still waiting. The SDK does not stop a schema
either: it stops waiting for it.

The SDK does not catch an error in code that the handler starts and does not await, including a
listener on `signal`. Such an error ends the function's process. Lambda then answers for the
request instead of the SDK.

## The handler's context

The SDK calls a handler with the `params`, `query` and `body` its route declares, each as its
schema outputs it. It also passes:

| Field | What it is |
|---|---|
| `caller` | `{ pairwiseId, pushId }`, read from the caller token. Each is a string wherever a string is taken, branded so one can't stand in for the other |
| `signal` | An `AbortSignal` that aborts when the deadline passes |
| `log` | A logger for the handler's own [log lines](#a-handlers-own-lines) |

## What a handler returns

A handler returns an object of `status` and `body` and nothing else, so it sets no header. The SDK
holds the result to the route. The handler must return one of:

- a status the route declares, with a body its schema accepts, or no body for a status declared
  `null`. The SDK sends what the schema outputs, as JSON. So an object schema that drops fields it
  doesn't declare keeps them from leaving;
- a 500, 502, 503 or 504, with no body, which any handler may return. The SDK sends it in the
  [platform's failure body](#the-sdks-own-answers), without `x-rejected-by`.

Anything else is a mistake in the handler, and the SDK answers with a 500. That covers:

- a result that is not an object;
- a field other than `status` and `body`;
- a status that is not a number, or not declared;
- a body on a status that takes none;
- a body its schema refuses;
- a body JSON can't write, such as a `BigInt`.

If a gateway call fails without an answer, the client throws a `GatewayInvocationError`. If the
handler lets it through, the SDK answers according to its `reason`:

| Reason | Status | Why |
|---|---|---|
| `timed_out` | 504 | The call had the request's deadline, so the request ran out of time |
| `function_error`, `invalid_response` | 502 | The gateway failed |
| `invoke_failed`, `aborted` | 500 | Lambda refused the call, or the handler abandoned it: the domain's own |

## The SDK's own answers

The SDK answers 400, 404, 405, 415, 500, 502 and 504 itself, with `x-rejected-by: domain`. It uses
the platform's failure body, which the Frontdoor and the domain's API also answer in:
`{"message":"Not found","type":"client_error"}`. The message is the status's name. `type` is
`client_error` for a 4xx and `server_error` for a 5xx. The body never says what was wrong with the
request. The log line does.

A request may send an `x-correlation-id` that is a trace ID in the format the
[Frontdoor sets](/flex-platform/frontdoor/cloudfront-function/), such as
`1-67a1b2c3-0123456789abcdef01234567`. If it does, the SDK sends it back on every response and logs
it as `traceId`. The SDK ignores any other value.

## Logging

The SDK writes JSON lines to standard output, under the domain's name. It writes exactly one line
for every request, as it answers. The line holds:

- `msg`, `<subject>: <what happened>`;
- `status`, and `durationMs`, the time it took;
- `route`, the key of the route that took it, once one did;
- `traceId`, when the request sent one.

The line's level says whose the outcome is:

- `info` for an answer the route declares;
- `warn` for the request's mistake, or a failure the SDK understands;
- `error` when the domain's code is wrong.

If code threw, the line carries `frames`: where the error was thrown, as file, line and column.

| Message | Status | Level |
|---|---|---|
| `request: answered by its route` | Declared | `info` |
| `caller: failed to read caller token` | 500 | `warn` |
| `route: none matches the path` | 404 | `warn` |
| `route: none for the method on this path` | 405 | `warn` |
| `query: refused, not declared by the route` | 400 | `warn` |
| `query: refused, rejected by its schema` | 400 | `warn` |
| `params: refused, does not decode to one segment` | 400 | `warn` |
| `params: refused, rejected by its schema` | 400 | `warn` |
| `body: refused, not declared by the route` | 400 | `warn` |
| `body: refused, missing` | 400 | `warn` |
| `body: refused, content type is not JSON` | 415 | `warn` |
| `body: refused, malformed JSON` | 400 | `warn` |
| `body: refused, nested too deeply` | 400 | `warn` |
| `body: refused, holds a __proto__ key` | 400 | `warn` |
| `body: refused, rejected by its schema` | 400 | `warn` |
| `query: failed, its schema threw`, and the same for `params` and `body` | 500 | `error` |
| `request: passed its deadline before its handler ran` | 504 | `warn` |
| `handler: passed the request's deadline` | 504 | `warn` |
| `handler: returned a server error` | 500, 502, 503 or 504 | `warn` |
| `handler: returned a result its route does not allow`, with `problem` | 500 | `error` |
| `handler: threw an unexpected error` | 500 | `error` |
| `gateway: call failed, uncaught by the handler`, with `reason` | 500, 502 or 504 | `warn` |
| `response: failed, its schema threw` | 500 | `error` |
| `response: passed the request's deadline` | 504 | `warn` |
| `sdk: failed while answering the request` | 500 | `error` |

A `problem` names the field and the rule it broke, such as
`status: 401 not declared, must be one of: 200, 500, 502, 503, 504`. It names no value from the
result except its status.

The SDK's line holds only fixed text and values that the configuration or the platform set. It
never holds a value from a request or a response. Nor does it hold an error's message, name or stack
text, because those can hold request or response values. The SDK logs an error by where it was
thrown.

The SDK logs with [Pino](https://getpino.io/).

### A handler's own lines

A handler's `log` is a child of the SDK's logger, so each line it writes carries the request's
`traceId` and `route`. A handler logs what it chooses, at any level, with two exceptions. The
caller's values are redacted, and `traceId` and `route` are always the request's.

```ts
log.info({ id: params.id }, "todo not found");
```

The SDK redacts the caller token, `pairwiseId` and `pushId` from what a handler writes through
`log`. It replaces any text that holds one of those exact values with `[redacted]`, wherever it is
on the line: the message, a field, a field's name, or a binding. This covers every line that `log`,
or any child of it, writes while the handler runs and in anything the handler starts. The SDK looks
only for the exact values. It does not find a part of the token, or a value the handler encodes.

Redaction follows the handler's asynchronous context, not the logger. A line written outside that
context has no caller's values redacted, or has another request's redacted. This includes:

- a line written through a logger kept beyond the request, such as one stored at module scope;
- a line written from a callback that something created in an earlier request runs later, such as
  a pooled connection's.

A logger the domain creates itself is not covered at all.

The SDK drops any value a handler writes under `traceId` or `route`, in a line's fields or with
`setBindings`. A child the handler creates with either name in its bindings writes that value too.
The request's value follows it, and a JSON reader keeps the later one. A child created with its own
`log` formatter replaces the formatter that writes them.

`log` is a Pino `Logger`, so a handler has the whole of Pino's
[logger API](https://getpino.io/#/docs/api?id=logger).
