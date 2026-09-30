---
title: Configuring a gateway
description: defineGateway, operation fields, policy, payload logging and secure bindings.
---

A gateway package holds a `gateway.config.ts` file. Its default export is a `defineGateway` call.
`defineGateway` keeps the operation names in the inferred type and fills in policy defaults. The
[UDP gateway](https://github.com/govuk-once/flex-platform/blob/main/gateways/services/udp/gateway.config.ts)
describes the User Data Platform API using the
[openapi-rest driver](/flex-platform/drivers/openapi-rest/overview/):

```ts
import { defineGateway } from "@repo/gateway-config";
import { apiKey, fromSecret, openapiRest, sigV4 } from "@repo/gateway-driver-openapi-rest";

export default defineGateway({
  id: "udp",
  description: "User Data Platform gateway",
  driver: openapiRest({
    spec: "https://raw.githubusercontent.com/govuk-once/user-data-platform/7ed6c9a3c57c06a64995eaae00195189f533926b/docs/openapi.yml",
    target: fromSecret("apiUrl"),
    auth: [
      apiKey({ header: "x-api-key", key: fromSecret("apiKey") }),
      sigV4({
        service: "execute-api",
        region: fromSecret("region"),
        role: {
          arn: fromSecret("consumerRoleArn"),
          externalId: fromSecret("externalId", { optional: true }),
          sessionName: "consumer-session",
        },
      }),
    ],
  }),
  operations: {
    createUser: {
      description: "Create User Record",
      upstream: "POST /v1/user",
    },
    getIdentityExchange: {
      description: "Look up a linked identity record for a different service",
      upstream: "GET /v1/identity/exchange",
      parameters: {
        requiredService: { in: "query" },
        requestingService: { in: "header", name: "requesting-service" },
        requestingServiceUserId: { in: "header", name: "requesting-service-user-id" },
      },
    },
    // …and each of UDP's other operations.
  },
});
```

Configuration is checked for its shape as well as its content. A misspelled operation, gateway or
driver field is a type error at `defineGateway` or the driver helper. It is not silently ignored.

| Gateway field | Purpose |
|---|---|
| `id` | Required non-empty gateway identifier. |
| `description` | Optional description. |
| `driver` | Required driver definition. It decides which extra operation fields are available. |
| `policy` | Optional overrides for `standardPolicy` defaults. |

| Operation field | Purpose |
|---|---|
| Driver-specific fields | Defined by the driver type, such as `upstream` and `parameters` above. |
| `description` | Optional description. The call contract writes it above the operation's types. |
| `log` | Optional allowlists of input and output fields. |
| `secure` | Optional mappings from input paths to envelope secure-value keys. |
| `handler` | Optional custom handler, made with the driver's `defineHandler` and typed against the driver. The runtime and CLI ignore it. The driver's executor calls it. |

A configuration never names an ARN, an address or a secret value. Importing a configuration never
touches the environment or AWS, because codegen loads it without either. Deployment values come
from the [environment](/flex-platform/reference/environment/).

## Policy

`upstreamTimeout` accepts a positive duration such as `"500ms"`, `"3s"` or `"1m"`. The default is
`"10s"`. An upstream attempt uses this timeout or the remaining request budget, whichever is
smaller. If the budget has run out, the call is not dispatched.

The configuration also accepts `circuitBreaker.threshold`, `circuitBreaker.duration` and
`rateLimit.rps`. The current runtime does not enforce these fields.

## Logging

`log.input` and `log.output` choose which request and response payload fields go into response
logs. If you leave out an allowlist, no payload fields from that side are logged.

```ts
log: {
  input: ["recordId"],
  output: ["status", "address.postcode", "results.*.name"],
}
```

Paths use dot notation. A wildcard expands across array entries or object values.

Only scalar values are logged:

- A path that resolves to an object or array is dropped.
- A number JSON cannot write is dropped. `NaN` and the infinities would appear in a log as null,
  which would look like a field that was null, not one that was not logged.
- A field that is null is logged as null.

Name `address.postcode`, not `address`, so that new nested fields are not logged automatically.

The allowlists only control payload fields. Diagnostic messages need separate care and must not
include sensitive values.

- When input fails validation, the log records the schema locations that rejected it and the
  keywords' own messages. It never records a path into the input. With a dictionary schema, the
  parts of such a path come from the caller's keys, and no allowlist selected those.
- The operation name also comes from the caller, until it matches a configured operation. If a
  request names no configured operation, its log line has no `operation` field, and the message
  does not repeat the name it sent. A recognised name belongs to the gateway, so it is logged.

## Secure bindings

Bindings require input fields to equal named values in `secure.values`. They do not currently
verify a signature or prove where those values came from.

```ts
secure: { "actor.id": "sub" }
```

The key is an exact dot path into the input. The value is a key in `secure.values`. Comparisons
are strict, with no type conversion. A missing input field, a missing secure value or a mismatch
produces `SECURE_VALUE_MISMATCH`. Malformed paths, wildcard paths and empty secure keys are
rejected when the handler is created.

Secure values must be strings, finite numbers, booleans or null. Other values produce
`INVALID_INPUT`. Allowing only scalars keeps payload preparation simple and deterministic. The
envelope requires a string `secure.signature`, but the runtime does not verify it.
