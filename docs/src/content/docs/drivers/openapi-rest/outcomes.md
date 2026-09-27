---
title: Outcomes and errors
description: How openapi-rest maps HTTP statuses to outcomes and error codes, and what it logs.
---

Status codes never reach the caller. Success statuses map to fixed outcome names. The schema's
`outcomes` must use these names as its keys.

| Status | Outcome |
|---|---|
| 200 | `ok` |
| 201 | `created` |
| 202 | `accepted` |
| 204 | `no_content`, with `data: null` |

Any other status becomes an error code.

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

A [custom handler](/flex-platform/drivers/openapi-rest/handlers/) can turn a status into an
outcome of its own. For example, it can turn a 404 into `unlinked`.

## Attempts, timeouts and bodies

Redirects are not followed. Each request is one `ctx.upstream` attempt. The attempt covers
authentication, the request and reading the body, so the policy timeout covers the whole
exchange. The runtime reports an aborted attempt as `UPSTREAM_TIMEOUT`. Nothing retries, except
the one replay of a GET after a refused credential. This is described under
[Authentication](/flex-platform/drivers/openapi-rest/authentication/#when-the-upstream-refuses-a-credential).

Bodies are buffered up to the driver's `maxResponseBytes` (1 MiB by default). A body that is
declared or streamed larger than this is cancelled and reported as `UPSTREAM_CONTRACT_VIOLATION`.

## Diagnostics

Diagnostic messages name the operation, its template, the status, and header or field names. They
never include a resolved path, a header value or a body. The driver raises each of its own
request-time failures as a `GatewayError`. Its message is written to be safe to log, and the
runtime records it unchanged.

Any other error that escapes, such as a library exception or a custom handler's own error, is
logged by the runtime as its source locations and the dispatcher step that was running. Its
message, name, properties, cause and stack text are never logged.

Within the attempt, the driver still replaces library exceptions with controlled ones. For
example:

- an error from `Headers` that quotes an invalid value;
- an authentication flow that fails with the request it was making, or the secret it read.
  Nothing of that error is kept.

A failing flow is reported as `INTERNAL`, unless it raised its own `GatewayError`. A transport
failure's name and system code appear in the `UPSTREAM_ERROR` diagnostic only when they match a
fixed set, such as `TypeError` and `ECONNREFUSED`.
