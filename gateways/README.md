# Gateways

Gateway libraries separate an upstream's operations from shared validation, dispatch, timeouts
and logging. Each gateway configuration describes one upstream.

## Package responsibilities

```txt
gateways/
  shared/
    config/        defineGateway, driver and operation types, policy presets
    types/         Envelope shapes, error codes and Validator
    runtime/       Envelope parsing, dispatch, timeouts, bindings and logging
    codegen/       Schema loading and standalone validator generation
  services/
    udp/           Example gateway configuration and schema fixtures
```

The codegen CLI reads `schemas.fixture.ts` and writes JavaScript validators to `.gen/validators/`.
For the included example, run:

```bash
pnpm --filter @govuk-once/flex-gateway-udp codegen
```

Run `pnpm build` from the repository root first to build workspace dependencies. The CLI does
not generate a deployable handler or client. The runtime's `createHandler` accepts validators,
an execution function and a deadline provider.

Token and signature verification are not implemented. Secure bindings check consistency of
values only. Of the configured policy settings, only `upstreamTimeout` is enforced.

## Gateway configuration

`defineGateway` preserves operation names in the inferred type and supplies policy defaults.
The [UDP gateway](services/udp/gateway.config.ts) describes the User Data Platform API.
Its local `openapiRest` helper constructs driver metadata; it does not implement transport.

```ts
import type { DriverDefinition } from "@repo/gateway-config";
import { defineGateway } from "@repo/gateway-config";

function openapiRest(config: {
  spec: string;
}): DriverDefinition<{ upstream: string }> {
  return { type: "openapi-rest", ...config };
}

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

| Gateway field | Purpose |
|---|---|
| `id` | Required non-empty gateway identifier. |
| `description` | Optional description. |
| `driver` | Required driver definition; determines additional operation fields. |
| `policy` | Optional overrides for `standardPolicy` defaults. |

| Operation field | Purpose |
|---|---|
| Driver-specific fields | Defined by the driver type, such as `upstream` in the example. |
| `description` | Optional description. |
| `log` | Optional input and output field allowlists. |
| `secure` | Optional mappings from input paths to envelope secure-value keys. |
| `handler` | Optional module path in the configuration type; not loaded by the current runtime or CLI. |

### Policy

`upstreamTimeout` accepts a positive duration such as `"500ms"`, `"3s"` or `"1m"`. The default is
`"10s"`. An upstream attempt uses the smaller of this timeout and the remaining request budget;
an exhausted budget prevents dispatch.

The configuration also accepts `circuitBreaker.threshold`, `circuitBreaker.duration`
and `rateLimit.rps`. These fields have no enforcement effect in the current runtime.

### Logging

`log.input` and `log.output` select request and response payload fields to include in response
logs. Omitting an allowlist selects no payload fields from that side.

```ts
log: {
  input: ["recordId"],
  output: ["status", "address.postcode", "results.*.name"],
}
```

Paths use dot notation. A wildcard expands across array entries or object values. Only scalar
matches are logged: a path resolving to an object or array is dropped. Name `address.postcode`
instead of `address` so newly added nested fields are not logged automatically.

These allowlists govern selected payload fields. Diagnostic messages require separate care and
must not include sensitive values.

### Secure bindings

Bindings require input fields to equal named values in `secure.values`. They do not currently
verify a signature or establish the origin of those values.

```ts
secure: { "actor.id": "sub" }
```

The key is an exact dot path into the input; the value is a key in `secure.values`. Comparisons
are strict, with no coercion. A missing input field, a missing secure value or a mismatch produces
`SECURE_VALUE_MISMATCH`. Malformed paths, wildcard paths and empty secure keys are rejected when
creating the handler.

Secure values must be strings, finite numbers, booleans or null. Other values produce
`INVALID_INPUT`. The scalar restriction keeps payload preparation simple and deterministic.
The envelope requires a string `secure.signature`, but the runtime does not verify it.

## Responses and errors

Success responses have the shape `{ ok: true, outcome, data }`. Failures are
`{ ok: false, error: { code } }`. Error messages are logged, not returned, to keep diagnostic
detail out of the response contract.

`ERROR_CODES` defines the following meanings. A defined code does not imply the corresponding
control is implemented: authentication, signature verification, circuit breaking and rate
limiting do not currently emit their reserved errors automatically.

| Code | Meaning |
|---|---|
| `INVALID_INPUT` | Envelope parsing or input schema validation failed. |
| `OPERATION_NOT_FOUND` | The gateway does not define the requested operation. |
| `UNAUTHENTICATED` | Authentication failure. |
| `SECURE_VALUE_MISMATCH` | An input binding is missing or does not match its envelope value. |
| `SECURE_SIGNATURE_INVALID` | Signature verification failure. |
| `NOT_FOUND` | The upstream has no matching record. |
| `UPSTREAM_REJECTED` | The upstream refused the request. |
| `UPSTREAM_ERROR` | The upstream failed to answer for a server or transport reason. |
| `UPSTREAM_TIMEOUT` | The attempt timed out or had no remaining budget. |
| `UPSTREAM_CONTRACT_VIOLATION` | The result failed outcome validation. |
| `UPSTREAM_UNAVAILABLE` | An upstream call was prevented by a gateway availability control. |
| `RATE_LIMITED` | A gateway rate limit rejected the call. |
| `INTERNAL` | An unexpected gateway error. |

The runtime classifies errors for health reporting. Gateway-side rejections are neutral to
upstream health; upstream responses and failures have separate classifications.

## Design constraints

- Keep transport details in adapters. Make each upstream call with `ctx.upstream(fn)`; the
  runtime applies the timeout and passes an abort signal to `fn`.
- Keep deployment-specific addresses, credentials and environment names out of gateway code.
- Emitted validators have no package imports or type declarations. Their helpers are bundled
  during generation so they can run independently of codegen's installed dependencies.
- Preserve compatibility of established contracts. Incompatible changes require a distinct
  gateway identity.

See [CLAUDE.md](../CLAUDE.md) for contributor conventions and the rationale for these boundaries.
