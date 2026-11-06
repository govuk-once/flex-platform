---
title: How a gateway works
description: How a gateway is built, what runs when, and what happens to a request.
---

A gateway is how the platform calls one upstream. It is a Lambda function, generated from a
configuration in this repository, and a domain invokes it to call that upstream. See
[The platform](/flex-platform/start/platform/) for where gateways sit.

A gateway groups the upstream's operations. It keeps transport details apart from validation and
dispatch. Anything that names HTTP, or another transport, lives in a driver. The runtime and the
generator only see an opaque driver definition and an execution function.

## Packages

```txt
gateways/
  shared/
    core/          Envelope shapes, error codes, Validator, driver contract, schema and secret shapes
    config/        defineGateway, driver definition and executor contract, policy presets
    runtime/       Envelope parsing, dispatch, timeouts, bindings, logging and secret retrieval
    client/        The gateway client, which domains install to call a gateway
    codegen/       Schema loading, configuration checks, validators, contract and entry point
  drivers/
    openapi-rest/  HTTP request construction, status mapping, authentication and custom handlers
  services/
    udp/           The User Data Platform gateway: configuration and schemas
  infra/           The names the CDK app gives gateways, such as the functions a domain may invoke
packages/          Shared TypeScript, ESLint and Vitest tooling, and generic utilities
```

`packages/` holds the shared tooling configuration and generic utilities. See
[Packages](/flex-platform/reference/packages/) for every package and what it depends on.

## Build time and run time

A gateway goes through two commands and then a deployment.

1. **`gateway-schemas`** is run by a person. It uses the gateway's driver to derive schemas from
   the upstream's own description, or from schemas the configuration declares. It compares them
   with the latest committed version. If the shape changed safely, it writes the next version. See
   [Schemas and versions](/flex-platform/gateways/schemas/).
2. **`gateway-codegen`** runs locally and in CI. It loads the configuration and the latest schema
   version. It checks that each version is compatible with every version before it, and that the
   configuration agrees with the latest version. It then writes `.gen/`, which holds:
   - standalone validators
   - an entry point and its esbuild bundle for the gateway
   - a typed call contract for callers
   - the client package a domain installs

   See [Code generation](/flex-platform/codegen/overview/).
3. **The bundle** runs as a Lambda function in the egress section. Deploying it is planned. It
   will be placed `isolated` or `private` depending on how its upstream is reached. When it loads,
   the entry point:
   - reads the environment
   - asks the driver for its executor, which retrieves and validates the gateway's secret
   - compiles the handler

   If the initial secret read fails or its value is invalid, initialisation fails before the
   handler can process an event. Later secret reads can still fail during a request.

## A request

The deployed handler receives an envelope:

```json
{
  "operation": "getIdentityExchange",
  "input": { "requiredService": "app", "requestingService": "app", "requestingServiceUserId": "u1" },
  "secure": { "token": "eyJhbGciOiJFZERTQSIs…" }
}
```

It handles the envelope in a fixed order. Each step has its own error code for a failure at that
step. Failures handled by the dispatcher are returned as envelopes. Initialisation and Lambda
invocation failures occur outside this flow and must also be handled by a caller.

| Step | What happens | Failure |
|---|---|---|
| Envelope | The envelope is parsed and its shape checked. | `INVALID_INPUT` |
| Token | The [caller token](/flex-platform/frontdoor/caller-token/) is verified. A call without one is refused, and so is one whose token fails any check. | `UNAUTHENTICATED` without a token, `SECURE_SIGNATURE_INVALID` for one that fails |
| Routing | The operation name is looked up among the configured operations. | `OPERATION_NOT_FOUND` |
| Input | The input is checked against the operation's generated validator, before any upstream call. | `INVALID_INPUT` |
| Bindings | Input fields bound to a claim of the verified token are compared with it. | `SECURE_VALUE_MISMATCH` |
| Deadline | The request's time budget is worked out from the invocation's remaining time, minus a safety margin. | |
| Execute | The driver's execute function runs. It makes each upstream call through `ctx.upstream`. Each attempt is limited to `upstreamTimeout` or the budget left, whichever is smaller. | Any `GatewayError` the driver raises, or `UPSTREAM_TIMEOUT` if an attempt timed out or had no budget left |
| Outcome | The driver's result is checked against the schema for the outcome it named. | `UPSTREAM_CONTRACT_VIOLATION` |
| Health | The result or error is classified for upstream health and logged. | |
| Response | `{ ok: true, outcome, data }` or `{ ok: false, error: { code } }`, with any declared `meta`. | `INTERNAL` for anything uncaught |

The handler compiles once, when it is created. It takes each invocation's deadline as an
argument, so nothing specific to one invocation is captured when it is created. Invalid configuration fails when the
handler is created, never on a request. See
[Responses and errors](/flex-platform/gateways/responses/) for the response shapes and every error
code.

## Where things live

| Concern | Lives in | Never in |
|---|---|---|
| Methods, paths, status codes, headers | The driver | The runtime, the generator, a caller's types |
| Operation names, schemas, log allowlists | The gateway's configuration and `schemas/` | The driver |
| Upstream address | The deployment's environment, or a field of the secret the configuration names | Any gateway code |
| Secret ARN | The deployment's environment | Any gateway code |
| Which fields of the secret mean what | The driver definition in the configuration | The runtime |
| Retry behaviour | Nowhere yet | A driver |
