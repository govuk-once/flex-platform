# CLAUDE.md

Contributor conventions for AI agents and humans working in this repository. Read this file
before making changes. Work within the requested scope; design constraints are not a work queue.

## Purpose and structure

Flex Platform contains gateway libraries and shared development tooling. A gateway groups
operations for one upstream, keeping transport details separate from validation and dispatch.

- `packages/`: TypeScript, ESLint and Vitest configuration shared across the repository.
- `gateways/shared/config`: `defineGateway`, the driver definition with its `createExecutor`
  contract and neutral `ExecutorOptions`, operation types and policy presets.
- `gateways/shared/types`: envelope shapes, error codes, the shared `Validator` interface, the
  driver context and execute types, the operation schema shapes and the secret provider shape.
- `gateways/shared/runtime`: envelope parsing, dispatch, input and outcome validation, secure
  value comparisons, upstream timeouts, payload field selection for logs, and retrieval of the
  gateway secret from AWS Secrets Manager through Powertools Parameters.
- `gateways/shared/codegen`: schema loading, the build-time check of a configuration against
  its schemas, standalone JavaScript validator generation and the call contract.
- `gateways/drivers/openapi-rest`: the HTTP driver. Builds `fetch` requests from operation
  mappings, maps statuses to outcomes and error codes, and dispatches to custom handlers the
  entrypoint supplies. Nothing in it is called by hand; a generated entrypoint wires it.
  `src/config/` is what a gateway configuration imports and codegen evaluates; `src/runtime/`
  is reached only through the definition's `createExecutor`, which loads it, and a lint rule
  keeps the two apart.
- `gateways/services/udp`: an example gateway configuration and schema fixtures.

The CLI reads `schemas.fixture.ts`, checks the configuration against it, and writes the
validators to `.gen/runtime/` and the call contract to `.gen/client/`. It does not produce a
client: a consumer takes the generated types and invokes the deployed gateway itself. Token and signature verification are not implemented;
secure bindings check value consistency only. Of the policy settings, only `upstreamTimeout`
is enforced.

See [the gateway guide](gateways/README.md) for configuration and runtime behaviour.

## Commands

Run from the repository root. Turborepo orchestrates per-package tasks.

```bash
pnpm install          # link the workspace and install dependencies
pnpm lint             # eslint, all packages
pnpm typecheck        # tsc --noEmit, all packages with a typecheck script
pnpm codegen          # generate validators for gateways that configure it
pnpm test             # vitest run, all packages
```

Per package: `pnpm --filter <name> <script>`.

Use pnpm and the existing scripts. Do not use `npx`, `npm`, `yarn` or `pnpx`; use `pnpm exec`
when a tool has no package script.

## Toolchain

| Tool | Convention |
|---|---|
| Runtime | Node 24 (`.nvmrc`), ESM, async handlers |
| Packages | Export TypeScript source from `package.json`; nothing compiles or emits `dist/` |
| Language | TypeScript strict mode, including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax` |
| Package manager | pnpm workspaces; version pinned in the root `packageManager` field |
| Task runner | Turborepo |
| Validator bundler | esbuild, ESM output targeting Node 24 |
| Tests | Vitest with `globals: false`; import test helpers explicitly |
| Validation | Ajv standalone validators from JSON Schema |
| Logging | pino, with payload fields selected through `log.input` and `log.output` |

Check installed dependencies and APIs before using them. Dependency version pins are exact
(`savePrefix: ""`); keep them exact.

## Repository conventions

- Keep gateway-specific code under `gateways/`. Use `packages/` only for tooling shared across
  the repository. Shared gateway libraries belong in `gateways/shared/`.
- Each package owns its configuration and extends the shared tooling. Add a root-level tool
  configuration only when the tool requires it, with a comment explaining why.
- Every package extends the one TypeScript base, `base.json`: strict, no emit. Packages export
  their `.ts` sources directly; Vitest, esbuild and tsx consume them as they are.
- ESLint provides `base`, `driver` and `service` presets. Drivers own transport access; services
  must use gateways. The service preset restricts common network globals and builtin imports;
  it is not a complete enforcement mechanism for network isolation. Review transport access.
- Generated artifacts are ignored, including `.gen/`, `dist/`, `.turbo/`, `cdk.out/` and
  `coverage/`. Do not commit them.
- Publishable packages use the `@govuk-once/` scope. Registry configuration lives in `.npmrc`.

## Design constraints

These are the boundaries whose violation is silent: the build stays green, the tests pass, and
the behaviour is wrong somewhere else. That is why they are listed rather than left to judgement.
Preserve them when extending the code. Requirements for integrations do not imply those
integrations are implemented.

1. **Transport-neutral contracts.** Runtime and codegen share JSON Schema and opaque driver
   definitions. Upstream methods, paths, status codes and headers belong in transport adapters.
   Adding a transport should not require transport-specific logic in the dispatcher or generator.
   `gateways/drivers/openapi-rest` is the only package that names methods, paths, status codes
   or headers; callers see outcome names such as `ok` and `no_content`, never a status.
   A driver definition carries its own `createExecutor`, so codegen and a generated entrypoint
   reach any driver the same way, as `config.driver`, and pass it the neutral `ExecutorOptions`;
   nothing outside a configuration names a driver package. A driver's handler type is a
   `BrandedHandler` carrying its `type`, produced only by that driver's `defineHandler`; a
   configuration imports its handlers statically and sets them on operations, so a handler
   cannot be wired to the wrong driver. Anything an entrypoint would need to know about a
   specific driver or gateway is a design error.

2. **Upstream calls use the driver context.** Make each upstream call with `ctx.upstream(fn)`,
   invoked once per call. The runtime invokes `fn` once per attempt, so `fn` must build its
   request each time and must not retry internally: a driver never expresses retry behaviour and
   so cannot get it wrong. Each attempt passes a fresh abort signal, which the driver should wire
   into its transport; the runtime bounds the whole of `fn` regardless, so a driver that ignores
   it stays correct but leaks the connection. Distinct calls are separate `upstream` invocations
   and share no attempt state, so parallel calls cannot spend each other's allowance. Convert
   transport errors to `GatewayError` with controlled diagnostic messages; library errors can
   contain payload data.

3. **Validate before dispatch and before returning data.** Preserve the handler's order:
   envelope parsing, token-verification hook, routing, input validation, secure bindings,
   deadline derivation, execution, outcome validation, health classification and response.
   The token hook currently performs no verification. Invalid configuration should fail when
   creating the handler, not per request. The handler compiles once and takes each
   invocation's deadline as an argument; nothing per invocation is captured at creation. A
   driver's `createExecutor` is asynchronous for the same reason: it retrieves the gateway
   secret through the provider in its options, validates it and instantiates its
   authentication state before it resolves, so a missing or invalid secret fails at startup and
   never on the first request. Look
   up outcome validators through a `Map`, never a plain object: the outcome name arrives from
   the driver at request time, and an object lookup finds inherited members.

   Each step owns a code: `INVALID_INPUT` for envelope parsing and input validation,
   `OPERATION_NOT_FOUND` for an unknown operation, `SECURE_VALUE_MISMATCH` for bindings,
   `UPSTREAM_CONTRACT_VIOLATION` for outcome validation, and `INTERNAL` for anything uncaught.
   Execution surfaces any `GatewayError` the driver raises; the runtime itself adds only
   `UPSTREAM_TIMEOUT` at that step. Input validation runs before any upstream call, so an
   invalid request never reaches one. Nothing throws out of the handler; every failure leaves
   as an envelope.

4. **Errors carry codes.** Failure responses are `{ ok: false, error: { code } }`. Diagnostic
   messages stay in logs and must be safe to log. A `GatewayError` is the declaration that a
   message is safe: the runtime records it as written. Any other error is logged as its source
   locations and the dispatcher step only, because a library or a custom handler can put a
   payload in the message, the name, the properties, the cause or the stack text, which is
   writable. The locations are read from V8's structured frames through a temporary
   `Error.prepareStackTrace` hook, as file, line and column only, never from the stack string;
   a stack already formatted or replaced yields none, and summarising an error must never
   throw. Source filenames are trusted deployment metadata: eval frames are skipped, but that
   does not cover every way a script can be created under a payload-derived name, so the
   protection covers what an error says, not where code chose to load itself from. Drivers
   therefore raise their own request-time failures as `GatewayError`, `INTERNAL` for
   configuration bugs, so the diagnosis survives.
   Success responses use `{ ok: true, outcome, data }`, keeping the outcome separate from
   upstream fields.

5. **Error codes declare health semantics.** Every code in `ERROR_CODES` has a signal ruling.
   `NOT_FOUND` and `UPSTREAM_REJECTED` represent an upstream response; contract violations and
   timeouts represent failures. Gateway-side rate limits and breaker rejections must remain
   neutral to upstream health to avoid feeding a control's own output back into it. The runtime
   currently logs these classifications; it does not operate a breaker. An upstream 429 also
   maps to `RATE_LIMITED` and keeps that neutral ruling: the gateway's own limit should sit
   below any upstream threshold, so reaching one is a gateway configuration problem.

6. **Payload logging is explicit and leaf-only.** Select fields with `log.input` and
   `log.output`. Paths resolving to objects or arrays are dropped so newly added nested fields
   are not logged automatically. Keep tests checking that unselected fields and synthetic
   secrets are absent from captured payload logs. Review diagnostic messages separately: a
   validation failure is logged as the schema locations that rejected it, never as an instance
   path, whose segments a dictionary schema takes from the caller's own keys.

7. **Preserve contract compatibility.** Changes to an established gateway contract must be
   additive. An incompatible contract requires a distinct gateway identity. This is a design
   rule, not a claim of automated compatibility checking.

8. **Avoid duplicate upstream writes.** Any invocation client must disable automatic SDK
   retries (`maxAttempts: 1`). Retry decisions require operation and deadline awareness;
   transport retries alone do not provide that, and neither does an attempt count in the
   policy, which is why there is none. Nothing retries a call today.

9. **Emitted validators are self-contained JavaScript.** Bundle Ajv runtime helpers and formats
   at generation time, resolving them from codegen's dependencies. Do not maintain a manual
   list of helpers. Validator output has no package imports or declaration files; this rule
   applies to validators, not every possible generated artifact; the call contract imports the
   package that declares the envelope types. Preserve subprocess tests outside workspace
   dependency resolution and fixtures that exercise runtime helpers. Generated code is not
   typechecked and nothing outside `.gen/` imports it, so the generated contract is checked by
   compiling it in a codegen test.

10. **Keep shared types independent of execution.** `@repo/gateway-types` has no package
    dependencies. Consumers can name envelopes and error codes without installing the runtime
    or generator. Parsing and `GatewayError` belong in the runtime. Import a shared type from
    the package that declares it: no package re-exports another's types, and every package that
    uses one declares the dependency itself. Preserve literal operation names in `defineGateway`
    types.
    A driver that needs a check relating one operation field to another registers it by
    augmenting `OperationRefinements`, keyed by its literal `type`; the config package holds
    only that slot and no driver vocabulary.

11. **Keep configuration environment-independent.** Do not hard-code deployed addresses,
    credentials or environment names in gateway code. Deployment-specific configuration belongs
    at the integration boundary. Every driver takes its upstream location from
    `UPSTREAM_TARGET` and its secret from the AWS Secrets Manager secret whose ARN is in
    `UPSTREAM_SECRET_ARN`, both named in the runtime and both required, a gateway that sends no
    credential included. What the target means, and what the secret must contain, are the
    driver's decisions, declared on its definition; the runtime only retrieves the secret as a
    JSON object and caches it for a bounded age. Read the variables at the entrypoint through
    `readUpstreamOptions`, which builds the secret provider, and pass the result in, never
    inside a request. A gateway configuration never names an ARN or a secret value, and
    importing one never reaches the environment or AWS.

12. **Secrets are validated before use and authentication is driver-owned.** The runtime reads
    the secret through Powertools Parameters as a JSON object, served from its cache for a
    bounded age and read again after that; concurrent reads on an expired cache may each reach
    the store, and a read a caller has stopped waiting for completes on its own. It knows
    nothing of the fields. A driver's validator, or the one its configured authentication
    definition supplies, runs on the initial secret and on every read after it, in the shared
    `Validator` convention, before any value reaches authentication code; an invalid secret is
    never returned and the affected operation fails. Diagnostics about a secret name the
    schema location that rejected it, never a value, a path into the secret (a dictionary
    schema takes those segments from its keys), a field it was not expected to have, or a
    validator's message; a failed read is reported as a fixed message with nothing of the
    library's error. An authentication definition declares the headers it owns; the driver
    reserves them before compiling operations, so no static header, mapping or handler can set
    them, and the definition may set no other. Its state is built per executor, its network
    access goes through the driver's transport facility, and nothing in a configuration module
    reads a secret or exchanges a token at import. Token and session expiry belong to the
    authentication definition. Nothing replays an upstream operation after an authentication
    failure.

## Public documentation and comments

Describe implemented behaviour and the rationale needed to maintain it. Include proposed changes
only when they explain an existing design constraint, label them clearly, and review their
relevance and security implications before publication. Keep implementation schedules and
sensitive operational details out of public contributor guidance. Preserve limitations needed
to use the code safely; do not imply that an unimplemented control provides protection.

Keep comments close to the code they explain. Prefer a short explanation of a constraint or
non-obvious decision over a roadmap, a deployment narrative or a repeat of this guide.

## Build and test notes

- Nothing is compiled. Workspace packages resolve to each other's sources, so typecheck and
  tests see a dependency change immediately and no task waits on another package.
- The codegen CLI is `src/cli.ts`, started by `bin/gateway-codegen.js`, which registers tsx
  and imports it. The CLI and the gateway configurations it loads therefore have the whole
  language available, not the subset Node strips on its own.
- Test literal operation-key inference at the type level; widening it to `string` loses useful
  information for codegen and handler authors.
