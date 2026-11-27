---
title: How a gateway works
description: How a gateway is built, what runs when, and what happens to a request.
---

A gateway is how the platform calls one upstream. It is a Lambda function, generated from a
configuration in this repository. A domain invokes it to call that upstream. See
[The platform](/flex-platform/start/platform/) for where gateways sit.

A gateway groups the upstream's operations. It keeps transport details apart from validation and
dispatch. Anything that names HTTP, or another transport, lives in a driver. The runtime and the
generator see only an opaque driver definition and an execution function.

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

1. **`gateway-schemas`**: a person runs it. It uses the gateway's driver to derive schemas from
   the upstream's own description, or from schemas the configuration declares. It compares them
   with the latest committed version. If the shape changed safely, it writes the next version. See
   [Schemas and versions](/flex-platform/gateways/schemas/).
2. **`gateway-codegen`**: it runs locally and in CI. It loads the configuration and the latest schema
   version. It checks that each version is compatible with every version before it, and that the
   configuration agrees with the latest version. It then writes `.gen/`, which holds:
   - standalone validators
   - an entry point and its esbuild bundle for the gateway
   - a typed call contract for callers
   - the client package a domain installs

   See [Code generation](/flex-platform/codegen/overview/).
3. **The bundle**: it runs as a Lambda function in the egress section, which its
   [stack](/flex-platform/infrastructure/overview/#stacks) deploys. It is placed `isolated` or
   `private`, depending on how its upstream is reached. When the bundle loads, the entry point:
   - reads the environment
   - asks the driver for its executor, which retrieves and validates the gateway's secret
   - compiles the handler

   If the first secret read fails, or the value is invalid, initialisation fails. The handler
   never processes an event. Later secret reads can still fail during a request.

## Placement

A gateway runs in one of two placements. The placement depends on how its upstream is reached:

| Placement  | Upstream                                             | Route out                              |
| ---------- | ---------------------------------------------------- | -------------------------------------- |
| `isolated` | Reached privately, such as another AWS account's API | A VPC endpoint                         |
| `private`  | Reached over the internet                            | A NAT gateway. Filtering its traffic beyond DNS is planned |

The gateway's code is the same in both placements. Placement belongs to its deployment, in the
[CDK app's config](/flex-platform/infrastructure/config/), not to the gateway's
configuration. The upstream's address and the secret the gateway uses to authenticate to it are
deployment values too. See [Environment](/flex-platform/reference/environment/).

## A request

The deployed handler receives an envelope:

```json
{
  "operation": "getIdentityExchange",
  "input": { "requiredService": "app", "requestingService": "app", "requestingServiceUserId": "u1" },
  "secure": { "token": "eyJhbGciOiJFZERTQSIs…" }
}
```

The handler takes the envelope through a fixed order of steps. Each step has its own error code
for a failure at that step. The dispatcher returns each failure it handles as an envelope.
Initialisation and Lambda invocation failures happen outside this flow, so a caller must handle
them too.

| Step | What happens | Failure |
|---|---|---|
| Envelope | The handler parses the envelope and checks its shape. | `INVALID_INPUT` |
| Token | The handler verifies the [caller token](/flex-platform/frontdoor/caller-token/). It refuses a call without one, and a call whose token fails any check. | `UNAUTHENTICATED` without a token, `SECURE_SIGNATURE_INVALID` for one that fails |
| Routing | The handler looks up the operation name among the configured operations. | `OPERATION_NOT_FOUND` |
| Input | The handler checks the input against the operation's generated validator, before any upstream call. | `INVALID_INPUT` |
| Bindings | The handler compares each input field bound to a claim of the verified token with that claim. | `SECURE_VALUE_MISMATCH` |
| Deadline | The handler works out the request's time budget: the invocation's remaining time, minus a safety margin. | |
| Execute | The driver's execute function runs. It makes each upstream call through `ctx.upstream`. Each attempt is limited to `upstreamTimeout` or the budget left, whichever is smaller. | Any `GatewayError` the driver raises, or `UPSTREAM_TIMEOUT` if an attempt timed out or had no budget left |
| Outcome | The handler checks the driver's result against the schema for the outcome it named. | `UPSTREAM_CONTRACT_VIOLATION` |
| Health | The handler classifies the result or error for upstream health, and logs it. | |
| Response | The handler returns `{ ok: true, outcome, data }` or `{ ok: false, error: { code } }`, with any declared `meta`. | `INTERNAL` for anything uncaught |

The handler compiles once, when it is created. It takes each invocation's deadline as an
argument, so it captures nothing specific to one invocation. Invalid configuration fails when the
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
