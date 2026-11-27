---
title: Configuring a gateway
description: defineGateway, operation fields, policy, payload logging and secure bindings.
---

A gateway package holds a `gateway.config.ts` file. Its default export is a `defineGateway` call.
`defineGateway` keeps the operation names in the inferred type, and fills in policy defaults. The
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
    spec: "https://raw.githubusercontent.com/govuk-once/user-data-platform/8472d85dbb8028300de71fb867b9a3e17d578196/docs/openapi.yml",
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

The type checker checks the shape of a configuration as well as its content. A misspelled
operation, gateway or driver field is a type error at `defineGateway` or the driver helper. Nothing
silently ignores it.

| Gateway field | Purpose |
|---|---|
| `id` | Required. 1 to 32 lowercase letters, digits and hyphens. It starts with a letter and does not end with a hyphen. It names the gateway's function and its client package. See [What codegen checks](/flex-platform/codegen/checks/). |
| `description` | Optional description. |
| `driver` | Required driver definition. It decides which extra operation fields you can use. |
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

The policy bounds how long an upstream call may take. It also holds settings for a circuit
breaker and a rate limit.

| Field | Default | Enforced |
|---|---|---|
| `upstreamTimeout` | `"10s"` | Yes |
| `circuitBreaker.threshold` | 5 | No |
| `circuitBreaker.duration` | `"120s"` | No |
| `rateLimit.rps` | None | No |

`upstreamTimeout` accepts a positive duration such as `"500ms"`, `"3s"` or `"1m"`. `defineGateway`
fills in the defaults from `standardPolicy`. The current runtime does not enforce the circuit
breaker or rate limit fields, or check their values.

A request's budget is the time the Lambda invocation has left, less 500 ms that the gateway keeps
to answer. An upstream attempt uses the timeout or the remaining budget, whichever is smaller. If
the budget has run out, the runtime does not dispatch the call.

Only an upstream call made through `ctx.upstream` is held to the timeout and the budget. Work that a
[custom handler](/flex-platform/drivers/openapi-rest/handlers/) does outside one has no timeout of
its own. Only the invocation's own time limit stops it.

## Logging

`log.input` and `log.output` choose which request and response payload fields go into response
logs. If an allowlist is left out, the gateway logs no payload fields from that side.

```ts
log: {
  input: ["recordId"],
  output: ["status", "address.postcode", "results.*.name"],
}
```

Paths use dot notation. A wildcard expands across array entries or object values.

The gateway logs only scalar values:

- It drops a path that resolves to an object or array.
- It drops a number JSON cannot write. `NaN` and the infinities would appear in a log as null.
  That would look like a field that was null, not one that was not logged.
- It logs a field that is null as null.

Name `address.postcode`, not `address`, so that new nested fields are not logged automatically.

The allowlists control only payload fields. Diagnostic messages need separate care, and must not
include sensitive values.

- If input fails validation, the log records the schema locations that rejected it and the
  keywords' own messages. It never records a path into the input. With a dictionary schema, the
  parts of such a path come from the caller's keys, and no allowlist selected those.
- The operation name also comes from the caller, until it matches a configured operation. If a
  request names no configured operation, its log line has no `operation` field. The message does
  not repeat the name the request sent. A recognised name belongs to the gateway, so the gateway
  logs it.

## Secure bindings

A binding holds an input field to a claim of the
[caller token](/flex-platform/frontdoor/caller-token/). The gateway has already verified the token
by this step. Bindings keep a domain to its own caller's records. Any domain may call any gateway,
so without a binding a domain could ask for any user.

```ts
secure: { requestingService: "service", requestingServiceUserId: "pairwiseId" }
```

The key is an exact dot path into the input. The value is a claim, one of `SECURE_CLAIMS` in
`@repo/gateway-core`:

- `pairwiseId`: the caller's access token `username`
- `service`: the service whose namespace that ID is in
- `pushId`: the ID the caller's notifications are pushed to

Bind `pairwiseId` and `service` wherever an upstream takes both, because an ID read in another
service's namespace names someone else.

Every claim is a string. Comparisons are strict, with no type conversion. If an input field is
missing or does not match, the gateway answers with `SECURE_VALUE_MISMATCH`. The log names the path
and the claim, never either value.

Codegen refuses a binding to anything but a claim. It also refuses a binding of a field that the
input schema doesn't declare as a required string, all the way down its path. A field that could be
absent, or of another type, would refuse every call that leaves it out or sends it. The handler
refuses malformed and wildcard paths when it is created.

Each operation that acts for a user binds the fields that name the user, or says why it can't. A
field that holds the user's ID at another service can't be bound, because no claim vouches for it.
