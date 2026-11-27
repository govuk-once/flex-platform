---
title: Outcomes and errors
description: How openapi-rest maps HTTP statuses to outcomes and error codes, and what it logs.
---

Status codes never reach the caller. The driver maps each success status to a fixed outcome
name, and the schema's `outcomes` must use these names as its keys.

| Status | Outcome |
|---|---|
| 200 | `ok` |
| 201 | `created` |
| 202 | `accepted` |
| 204 | `no_content`, with `data: null` |

The driver turns any other status into an error code.

| Status | Code |
|---|---|
| 404 | `NOT_FOUND` |
| 401, 403 | `UPSTREAM_REJECTED`: the gateway's own credentials were refused |
| 429 | `RATE_LIMITED` (the same code as a gateway-side limit) |
| other 4xx | `UPSTREAM_REJECTED` |
| 5xx | `UPSTREAM_ERROR` |
| 1xx, 3xx, other 2xx | `UPSTREAM_CONTRACT_VIOLATION` |
| transport failure | `UPSTREAM_ERROR` |
| 2xx body that is not JSON | `UPSTREAM_CONTRACT_VIOLATION` |

A [custom handler](/flex-platform/drivers/openapi-rest/handlers/) can report a status as a
different one of these outcomes or codes. It cannot report an outcome of its own.

## Attempts, timeouts and bodies

Each request is one `ctx.upstream` attempt, and the driver does not follow redirects. The
attempt covers authentication, the request and reading the body, so the policy timeout covers the
whole exchange. The runtime reports an aborted attempt as `UPSTREAM_TIMEOUT`.

Nothing retries, except the one replay of a GET after a refused credential. See
[Authentication](/flex-platform/drivers/openapi-rest/authentication/#when-the-upstream-refuses-a-credential).

The driver buffers a body up to its `maxResponseBytes` (1 MiB by default). If a body is declared
or streamed larger than this, the driver cancels it and reports `UPSTREAM_CONTRACT_VIOLATION`.

## Diagnostics

The driver's diagnostics are safe to log. They name the operation, its template, the status, and
header or field names. They never include a resolved path, a header value or a body.

The driver raises each of its own request-time failures as a `GatewayError`. Its message is
written to be safe to log, and the runtime records it unchanged.

Other errors can escape, such as a library exception or a custom handler's own error. The runtime
logs each of these as its source locations and the dispatcher step that was running. It never
logs the error's message, name, properties, cause or stack text.

Within the attempt, the driver still replaces library exceptions with controlled ones. For
example, it replaces:

- an error from `Headers` that quotes an invalid value;
- an error from an authentication flow that includes the request it was making, or the secret it
  read. Nothing of that error is kept.

The driver reports a failing flow as `INTERNAL`, unless the flow raised its own `GatewayError`. A
transport failure's name and system code appear in the `UPSTREAM_ERROR` diagnostic only if they
match a fixed set, such as `TypeError` and `ECONNREFUSED`.
