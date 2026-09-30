---
title: Responses and errors
description: The response envelope, response metadata, error codes and their health rulings.
---

Success responses have the shape `{ ok: true, outcome, data }`. Failures are
`{ ok: false, error: { code } }`. Error messages are logged, not returned, to keep diagnostic
detail out of the response contract. The outcome is kept separate from the upstream's fields. It is
a name such as `ok` or `created`, never a status code.

```ts
type EnvelopeResponse =
  | { ok: true; outcome: string; data: unknown; meta?: EnvelopeMeta }
  | { ok: false; error: { code: ErrorCode }; meta?: EnvelopeMeta };
```

The dispatcher returns failures, including unexpected execution errors, as envelopes. This does
not cover failures outside the handler, such as initialisation or a failed Lambda invocation.
A caller must handle those separately from an `ok: false` response.

## Response metadata

Either response may also carry `meta`. This is what the gateway reports about a call alongside its
result, such as the upstream's own id for the request. That id is what the upstream's support
team asks for.

A gateway's schemas declare each name under `meta` with the schema of one scalar: a string, a
number, an integer or a boolean. It is never an object or a list. A driver reports a value through
its context, `ctx.meta(name, value)`, not in its result. This is because a driver that fails
throws, and what it learnt before it threw is what a caller most needs.

The runtime:

- keeps only the names the gateway declared
- validates each value against its schema
- returns the values that pass, on a failure as well as a success
- writes them to that call's log line

A value that fails validation is left out. The log records the schema location that refused it,
never the value. A name the gateway did not declare is left out too, and logged by name. The name
comes from the driver's own code, never from a caller or an upstream. Nothing reported in `meta`
can make a call fail.

Every part of `meta` is optional to a caller, and so is `meta` as a whole. A request refused
before it reached the upstream, or one whose response never arrived, has nothing to report. A call
that timed out still reports what the driver recorded before the timeout.

`meta` is not a second channel for diagnostics. Only declared, validated scalars travel in it.

Between [versions](/flex-platform/gateways/compatibility/), a name may be added or removed. Every
name is optional, so a caller already handles one being absent. A name that stays is compared in
the same way as an outcome's data, because both flow from the upstream to the caller.

For openapi-rest, `meta` values are read from response headers. See
[Response metadata](/flex-platform/drivers/openapi-rest/metadata/).

## Error codes

`ERROR_CODES` in `@repo/gateway-types` defines each code's meaning and its health ruling. A code
being defined does not mean its control is implemented. Authentication, signature verification,
circuit breaking and gateway-side rate limiting do not currently emit their reserved errors. The
driver decides which upstream responses produce which codes. See
[openapi-rest outcomes and errors](/flex-platform/drivers/openapi-rest/outcomes/).

| Code | Meaning | Health ruling |
|---|---|---|
| `INVALID_INPUT` | Envelope parsing or input schema validation failed. | none |
| `OPERATION_NOT_FOUND` | The gateway does not define the requested operation. | none |
| `UNAUTHENTICATED` | Authentication failure. | trust |
| `SECURE_VALUE_MISMATCH` | An input binding is missing or does not match its envelope value. | trust |
| `SECURE_SIGNATURE_INVALID` | Signature verification failure. | trust |
| `NOT_FOUND` | The upstream has no matching record. | upstream success |
| `UPSTREAM_REJECTED` | The upstream refused the request. | upstream success |
| `UPSTREAM_ERROR` | The upstream failed to answer for a server or transport reason. | upstream failure |
| `UPSTREAM_TIMEOUT` | The attempt timed out or had no remaining budget. | upstream failure |
| `UPSTREAM_CONTRACT_VIOLATION` | The result failed outcome validation. | upstream failure |
| `UPSTREAM_UNAVAILABLE` | A gateway availability control prevented an upstream call. | none |
| `RATE_LIMITED` | A rate limit rejected the call. This can be the gateway's own limit or the upstream's. | none |
| `INTERNAL` | An unexpected gateway error. | unhandled |

## Health rulings

The runtime classifies each result for upstream health and logs the classification. It does not
yet operate a circuit breaker.

- `NOT_FOUND` and `UPSTREAM_REJECTED` are answers from an upstream that is working, so they count
  as upstream success.
- Contract violations, timeouts and upstream errors count as upstream failures.
- Gateway-side rate limits and availability rejections are neutral. A control's own output must
  not feed back into it.
- An upstream 429 also maps to `RATE_LIMITED` and is also neutral. The gateway's own limit should
  sit below any upstream limit, so reaching an upstream limit is a gateway configuration problem.

## What reaches a log

A `GatewayError` declares that its message is safe to log, and the runtime records the message as
written.

Any other error is logged only as its source locations and the dispatcher step. Its message, name,
properties, cause and stack text are never logged, because a library or a custom handler can put a
payload in any of them. The locations are read from V8's structured stack frames, as file, line
and column only.
