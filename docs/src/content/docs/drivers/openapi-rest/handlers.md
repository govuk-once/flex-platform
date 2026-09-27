---
title: Custom handlers
description: Replacing an operation's automatic mapping with a handler of your own.
---

An operation with a `handler` skips the automatic mapping. A handler is a value made by the
driver's `defineHandler` and set on the operation in the configuration. The usual place to write
it is a module next to the configuration.

The compiler checks the handler against the driver's handler type, which the definition exposes
through `HandlerOf`. That type is branded with the driver's `type`, and only `defineHandler`
produces it. So a plain function, or a handler written for another driver, is a type error on
that line. `defineHandler` also lets the author name the input type.

Handlers and the automatic mapping use the same client. Every upstream call still goes through
`ctx.upstream` once, and transport errors are mapped the same way.

For example, a handler for an identity lookup might turn the upstream's 404 into an `unlinked`
outcome. The operation's schemas then declare `unlinked` alongside `ok`:

```ts
import { defineHandler } from "@repo/gateway-driver-openapi-rest";

interface IdentityExchangeInput {
  requiredService: string;
  requestingService: string;
  requestingServiceUserId: string;
}

export default defineHandler(async (input: IdentityExchangeInput, client) => {
  const response = await client.request(client.prepare(input));
  if (response.status === 404) {
    return { outcome: "unlinked", data: null };
  }
  return client.mapResponse(response);
});
```

The input annotation states what the operation's input schema describes. The runtime validates
the input against that schema before the handler runs. The outcomes the handler returns are
inferred. Both stay on the handler's type, so calling it with the wrong input is a type error.

## The client

| Method | Does |
|---|---|
| `prepare(input)` | Builds the operation's automatic request from an input, applying the mapping. |
| `request(call)` | Sends a request once and returns the raw status, headers and body. A 4xx or 5xx is not an error here. |
| `mapResponse(response)` | Applies the [status mapping](/flex-platform/drivers/openapi-rest/outcomes/) to a response already received. Throws the mapped `GatewayError` for an error status. |
| `invoke(call)` | `request` followed by `mapResponse`. |

After `request`, use `mapResponse` on the response you already have. Do not call `invoke` after
`request`: it would send the request again and duplicate any write. For hand-written calls, build paths with
`encodePathParam`, which applies the single-segment rule.

## What codegen checks for a handler

A handler builds its own request. So codegen does not check what the automatic mapping would need
from its input schema. The handler decides about these:

- an unmapped field;
- a mapping naming a field the schema does not declare;
- a path parameter whose field the schema leaves optional;
- a `payload` the method could not carry.

What the executor compiles for every operation is still checked: the template's parameters, the
names a mapping takes, and the headers authentication owns. A handler that calls `prepare` is still
bound by the mapping, and the runtime reports a violation as `INTERNAL`. Nothing at generation
time can tell a handler that calls `prepare` from one that does not.

## Errors in a handler

If a handler throws its own error (anything other than a `GatewayError`), only its source
locations are logged, and the call returns `INTERNAL`. When the diagnosis matters, throw a
`GatewayError` with a message that is safe to log.
