# Gateways

Internal services that mediate all access to upstream APIs. Each gateway owns exactly one upstream.
Consumers get a stable typed RPC interface via `lambda:InvokeFunction` and never talk to an
upstream directly.

## How it works

You write a `gateway.config.ts` using `defineGateway` and codegen produces the rest: validators,
entry point, client types. All resilience (timeouts, retries, circuit breaking, rate limits),
credential custody and contract validation lives behind the tooling rather than in the gateway you
author.

## Writing a gateway config

```ts
import { defineGateway } from "@repo/gateway-config";

export default defineGateway({
  id: "udp",
  description: "User Data Platform gateway",
  driver: openapiRest({
    spec: "https://raw.githubusercontent.com/govuk-once/user-data-platform/refs/heads/main/docs/openapi.yml",
  }),
  operations: {
    createUser: {
      description: "Create User Record",
      upstream: "POST /v1/user",
    },
    getIdentityExchange: {
      description: "Look up a linked identity record for a different service",
      upstream: "GET /v1/identity/exchange",
    },
  },
});
```

### Gateway-level fields

| Field | Required | Purpose |
|---|---|---|
| `id` | Yes | Unique identifier for the gateway. Used in function naming and routing. |
| `description` | No | Human-readable description. |
| `driver` | Yes | A driver factory call (e.g. `openapiRest(...)`) that tells codegen and the runtime how to talk to the upstream. |
| `policy` | No | Override default policy settings. `standardPolicy` is applied automatically. |

### Operation-level fields

| Field | Required | Purpose |
|---|---|---|
| `upstream` | Driver-dependent | A string the driver interprets (e.g. `"GET /addresses/{uprn}"` for `openapiRest`). |
| `log` | No | Allowlist of fields safe to log. See [Logging](#logging). |
| `handler` | No | Escape hatch: path to a custom handler module for operations that can't be expressed as a simple upstream mapping. |
| `description` | No | Human-readable description of the operation. |

### Policy

A default policy (`standardPolicy`) is applied to every gateway automatically. To override
specific settings:

```ts
export default defineGateway({
  // ...
  policy: { upstreamTimeout: "3s", attempts: 3 },
});
```

Available policy fields:

- `upstreamTimeout` - duration string (e.g. `"5s"`, `"500ms"`)
- `attempts` - number of attempts including the initial call
- `circuitBreaker.threshold` - error count before opening
- `circuitBreaker.duration` - how long the breaker stays open
- `rateLimit.rps` - requests per second cap

### Logging

Logging is default-deny. Nothing from an upstream payload is logged unless explicitly named in an
operation's `log` field. This prevents accidental PII leakage when upstream APIs add new fields.

```ts
operations: {
  getIdentityExchange: {
    upstream: "GET /v1/identity/exchange",
    log: {
      input: ["serviceId"],
      output: ["status"],
    },
  },
}
```

- `log.input` - fields from the request payload safe to log
- `log.output` - fields from the response payload safe to log
- Omitting either means log nothing from that side
- Supports dot notation: `"address.postcode"`
- Supports wildcard array indices: `"results.*.name"`

## Environment variables

All gateway env vars use the prefix `FLEX_GATEWAY_`. Each gateway is its own Lambda, so the same
variable name resolves to different values per deployment.

| Variable | Purpose |
|---|---|
| `FLEX_GATEWAY_BASE_URL` | Upstream base URL. Set per environment by infra. |

The config is environment-free. URLs, credentials and anything that varies between environments
come from env vars resolved at cold start.

## Upstream spec pinning

The `spec` field in the driver config points to a pinned version of the upstream's API spec
(OpenAPI or equivalent). Schemas are extracted from this spec by codegen - they are never declared
in the config.

Pin to the version currently deployed to production. When the upstream promotes a new version,
update the pinned ref and regenerate. This ensures the gateway never exposes operations that don't
exist on the upstream in prod.

## Directory structure

```
gateways/
  shared/
    config/        @repo/gateway-config - defineGateway, types, presets
    runtime/       (planned) dispatcher, envelope, error taxonomy
    codegen/       (planned) loadConfig, emitValidators, emitEntry
    client/        (planned) invoke wrapper, typed errors
  drivers/
    openapi-rest/  (planned) OpenAPI REST driver
  services/
    udp/           @govuk-once/flex-gateway-udp - the first real gateway
```

## Key constraints

- No HTTP anywhere in the design. Consumers invoke via `lambda:InvokeFunction`.
- Drivers reach the network only through `ctx.call`. Raw `fetch`/`node:http`/`undici` is banned.
- Nothing in code names an environment.
- Contracts are additive-only. Breaking changes mean a new gateway (`udp-v2`), not a version bump.
