---
title: Requests
description: How the domain SDK answers a request, in order, what it answers itself, and what it logs.
---

The [domain SDK](/flex-platform/domains/overview/#domain-sdk) answers each request to a domain from
its [configuration](/flex-platform/domains/configuration/).

:::caution[Planned]
The SDK exports nothing a domain's function can serve requests with. Serving them from the
function, behind its [API's proxy integration](/flex-platform/domains/hosting/#routing-a-request),
is planned. Until then, no deployed domain's request passes through the steps on this page: the
SDK's own tests run them.
:::

## A request, in order

The first step that answers ends the request. Nothing a handler or a schema throws escapes: an
error that nothing else answers is a 500.

1. **The caller.** The SDK reads `pairwiseId` and `pushId` from the
   [caller token](/flex-platform/frontdoor/caller-token/) in `x-flex-secure`. It does not verify
   the token: API Gateway admits only requests the Frontdoor signed, and a gateway verifies the
   token on every call. The Frontdoor sends one on every request, so a request without a readable
   token is the platform's fault: a 500, before routing, so it learns nothing of the routes.
2. **The route.** See [Routing](#routing). A path no route has is a 404. A route's path with a
   method it doesn't take is a 405, with an `Allow` header naming the methods it does.
3. **The query.** A route without `query` refuses any query string. Otherwise each parameter is
   [read from its text](/flex-platform/domains/configuration/#path-and-query-fields) and the
   route's `query` schema validates the result.
4. **The path parameters.** Each is decoded once. One that doesn't decode, or decodes to text
   holding a `/`, is refused: it would name a path of its own. Each is then read from its text and
   the route's `params` schema validates the result.
5. **The body.** A route without `body` refuses a body that is not empty. A route with one refuses
   a request with no body, a `content-type` other than `application/json` (parameters such as
   `charset` are allowed) with a 415, text that is not JSON, JSON nested more than 64 objects or
   arrays deep, JSON holding a `__proto__` key at any depth, and JSON its `body` schema refuses.
   Every object in the body is read without a prototype, so the schema finds a field only where the
   request set it, never one such as `toString` that every object inherits.
6. **The handler.** The SDK calls the handler with its [context](#the-handlers-context), inside the
   gateway client's [caller context](/flex-platform/domains/overview/#the-caller-context), and waits
   for it until the [deadline](#the-deadline).
7. **The result.** What the handler returned is held to the route's
   [responses](#what-a-handler-returns), and sent.

Steps 3 to 5 answer a 400 for anything else they refuse, so a handler never sees input its schemas
refuse.

Schemas run with Zod's `safeParseAsync`, so a refinement or transform may be `async`. Input schemas
run before the handler, outside its caller context, so a gateway call made from one is refused.

## Routing

The SDK matches a request's method and path to a [route key](/flex-platform/domains/configuration/#route-keys).
A path matches a key when it has as many segments, each literal segment is equal once decoded,
case and all, and each parameter's segment is not empty. So `/v1/todos/` and `/v1/Todos` match no
route, `/v1/%74odos` matches `/v1/todos`, and a query string plays no part.

Two keys can match one request, such as `GET /v1/todos/{id}` and `GET /v1/todos/archived`. The key
with a literal segment takes it, at the first segment where the two differ, wherever either is
declared. An encoded spelling of the literal, such as `/v1/todos/%61rchived`, is the literal too, so
`{id}` is never `archived`.

The path is the one the domain's API passes on, after the Frontdoor
[removes the domain's segment](/flex-platform/frontdoor/lambda-edge/#routing).

## The deadline

The deadline is taken once, as the request arrives: the time the invocation has left, less 500
milliseconds kept back to answer in. Reading the input, the handler and the response's schema each
run until it, and whichever passes it is answered with a 504. A handler is never called once the
deadline has passed.

When it passes while the handler runs, the handler's `signal` aborts. The handler's work is not
stopped, but the gateway client has the same deadline, so a call made after it is refused before
it is sent, and one still waiting is abandoned. Nor is a schema stopped: the SDK stops waiting for
it.

The SDK does not catch an error in code the handler starts and does not await, including a listener
on `signal`. Such an error ends the function's process, and Lambda answers for the request instead
of the SDK.

## The handler's context

A handler is called with the `params`, `query` and `body` its route declares, each as its schema
output it, and:

| Field | What it is |
|---|---|
| `caller` | `{ pairwiseId, pushId }`, read from the caller token. Each is a string wherever a string is taken, branded so one can't stand in for the other |
| `signal` | An `AbortSignal` that aborts when the deadline passes |
| `log` | A logger for the handler's own [log lines](#a-handlers-own-lines) |

## What a handler returns

A handler returns an object of `status` and `body` and nothing else, so it sets no header. The SDK
holds it to the route:

- a status the route declares, with a body its schema accepts, or no body for a status declared
  `null`. The body sent is what the schema outputs, so an object schema that drops fields it
  doesn't declare keeps them from leaving. It is sent as JSON;
- or a 500, 502, 503 or 504, with no body, which any handler may return. The SDK sends it in the
  [platform's failure body](#the-sdks-own-answers), without `x-rejected-by`.

Anything else is a mistake in the handler, and a 500: a result that is not an object, a field
other than `status` and `body`, a status that is not a number or not declared, a body on a status
that takes none, a body its schema refuses, or one JSON can't write, such as a `BigInt`.

A gateway call that fails without an answer throws a `GatewayInvocationError`. One the handler lets
through is answered by its `reason`:

| Reason | Status | Why |
|---|---|---|
| `timed_out` | 504 | The call had the request's deadline, so the request ran out of time |
| `function_error`, `invalid_response` | 502 | The gateway failed |
| `invoke_failed`, `aborted` | 500 | Lambda refused the call, or the handler abandoned it: the domain's own |

## The SDK's own answers

The SDK answers 400, 404, 405, 415, 500, 502 and 504 itself, with `x-rejected-by: domain`, in the
platform's failure body that the Frontdoor and the domain's API also answer in:
`{"message":"Not found","type":"client_error"}`. The message is the status's name, and `type` is
`client_error` for a 4xx and `server_error` for a 5xx. The body never says what was wrong with the
request: the log line does.

A request's `x-correlation-id`, when it is a trace ID in the format the
[Frontdoor sets](/flex-platform/frontdoor/cloudfront-function/), such as
`1-67a1b2c3-0123456789abcdef01234567`, is sent back on every response and logged as `traceId`. Any
other value is ignored.

## Logging

The SDK writes JSON lines to standard output, under the domain's name. Every request gets
exactly one line from the SDK, written as it answers, with:

- `msg`, `<subject>: <what happened>`;
- `status`, and `durationMs`, the time it took;
- `route`, the key of the route that took it, once one did;
- `traceId`, when the request sent one.

Its level says whose the outcome is: `info` for an answer the route declares, `warn` for the
request's mistake or a failure the SDK understands, and `error` when the domain's code is wrong.
A line for code that threw carries `frames`, where the error was thrown, as file, line and
column.

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
result but its status.

The SDK's line holds fixed text and values the configuration or the platform set. It never holds a
value from a request or a response, or an error's message, name or stack text, which can hold
either: an error is logged by where it was thrown.

The SDK logs with [Pino](https://getpino.io/).

### A handler's own lines

A handler's `log` is a child of the SDK's logger, so each line it writes carries the request's
`traceId` and `route`. A handler logs what it chooses, at any level, except that the caller's values
are redacted and `traceId` and `route` are always the request's.

```ts
log.info({ id: params.id }, "todo not found");
```

The caller token, `pairwiseId` and `pushId` are redacted from what a handler writes through `log`.
Any text that holds one of those exact values is replaced with `[redacted]`, wherever it is on the
line: the message, a field, a field's name, or a binding. This covers every line `log`, or any child
of it, writes while the handler runs and in anything it starts. Only the exact values are looked
for: a part of the token, or a value the handler encodes, is not found.

Which values are redacted follows the handler's asynchronous context, not the logger. A line
written outside that context has no caller's values redacted, or another request's. This includes
a line written through a logger kept beyond the request, such as one stored at module scope, and
one written from a callback that something created in an earlier request runs later, such as a
pooled connection's. A logger the domain creates itself is not covered at all.

`traceId` and `route` are always the request's. A value a handler writes under either name, in a
line's fields or with `setBindings`, is dropped. A child the handler creates with either name in its
bindings writes that value too, followed by the request's, which is the one a JSON reader keeps. A
child created with its own `log` formatter replaces the one that writes them.

`log` is a Pino `Logger`, so a handler has the whole of Pino's
[logger API](https://getpino.io/#/docs/api?id=logger).
