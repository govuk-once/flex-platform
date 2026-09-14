# CLAUDE.md

Contributor conventions for AI agents and humans working in this repository. Read this file
before making changes. Work within the requested scope; design constraints are not a work queue.

## Purpose and structure

Flex Platform contains gateway libraries and shared development tooling. A gateway groups
operations for one upstream, keeping transport details separate from validation and dispatch.

- `packages/`: TypeScript, ESLint and Vitest configuration shared across the repository.
- `gateways/shared/config`: `defineGateway`, driver and operation types, and policy presets.
- `gateways/shared/types`: envelope shapes, error codes and the shared `Validator` interface.
- `gateways/shared/runtime`: envelope parsing, dispatch, input and outcome validation, secure
  value comparisons, upstream timeouts and payload field selection for logs.
- `gateways/shared/codegen`: schema loading and standalone JavaScript validator generation.
- `gateways/services/udp`: an example gateway configuration and schema fixtures.

The CLI currently reads `schemas.fixture.ts` and writes validators. It does not produce a
complete deployable gateway or client. Token and signature verification are not implemented;
secure bindings check value consistency only. Of the policy settings, only `upstreamTimeout`
is enforced.

See [the gateway guide](gateways/README.md) for configuration and runtime behaviour.

## Commands

Run from the repository root. Turborepo orchestrates per-package tasks.

```bash
pnpm install          # link the workspace and install dependencies
pnpm lint             # eslint, all packages
pnpm typecheck        # tsc --noEmit, all packages with a typecheck script
pnpm build            # build packages and run codegen where configured
pnpm test             # vitest run, with build dependencies
```

Per package: `pnpm --filter <name> <script>`.

Use pnpm and the existing scripts. Do not use `npx`, `npm`, `yarn` or `pnpx`; use `pnpm exec`
when a tool has no package script.

## Toolchain

| Tool | Convention |
|---|---|
| Runtime | Node 24 (`.nvmrc`), ESM, async handlers |
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
- TypeScript bases are `base.json` (strict, no emit), `library.json` (JavaScript and declarations)
  and `lambda.json` (JavaScript without declarations). Use the base appropriate to the build.
- ESLint provides `base`, `driver` and `service` presets. Drivers own transport access; services
  must use gateways. The service preset restricts common network globals and builtin imports;
  it is not a complete enforcement mechanism for network isolation. Review transport access.
- Build and generated artifacts are ignored, including `.gen/`, `dist/`, `*.tsbuildinfo`,
  `.turbo/`, `cdk.out/` and `coverage/`. Do not commit them.
- Publishable packages use the `@govuk-once/` scope. Registry configuration lives in `.npmrc`.

## Design constraints

These are the boundaries whose violation is silent: the build stays green, the tests pass, and
the behaviour is wrong somewhere else. That is why they are listed rather than left to judgement.
Preserve them when extending the code. Requirements for integrations do not imply those
integrations are implemented.

1. **Transport-neutral contracts.** Runtime and codegen share JSON Schema and opaque driver
   definitions. Upstream methods, paths, status codes and headers belong in transport adapters.
   Adding a transport should not require transport-specific logic in the dispatcher or generator.

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
   creating the handler, not per request.

   Each step owns a code: `INVALID_INPUT` for envelope parsing and input validation,
   `OPERATION_NOT_FOUND` for an unknown operation, `SECURE_VALUE_MISMATCH` for bindings,
   `UPSTREAM_CONTRACT_VIOLATION` for outcome validation, and `INTERNAL` for anything uncaught.
   Execution surfaces any `GatewayError` the driver raises; the runtime itself adds only
   `UPSTREAM_TIMEOUT` at that step. Input validation runs before any upstream call, so an
   invalid request never reaches one. Nothing throws out of the handler; every failure leaves
   as an envelope.

4. **Errors carry codes.** Failure responses are `{ ok: false, error: { code } }`. Diagnostic
   messages stay in logs and must be safe to log. Success responses use
   `{ ok: true, outcome, data }`, keeping the outcome separate from upstream fields.

5. **Error codes declare health semantics.** Every code in `ERROR_CODES` has a signal ruling.
   `NOT_FOUND` and `UPSTREAM_REJECTED` represent an upstream response; contract violations and
   timeouts represent failures. Gateway-side rate limits and breaker rejections must remain
   neutral to upstream health to avoid feeding a control's own output back into it. The runtime
   currently logs these classifications; it does not operate a breaker.

6. **Payload logging is explicit and leaf-only.** Select fields with `log.input` and
   `log.output`. Paths resolving to objects or arrays are dropped so newly added nested fields
   are not logged automatically. Keep tests checking that unselected fields and synthetic
   secrets are absent from captured payload logs. Review diagnostic messages separately.

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
   applies to validators, not every possible generated artifact. Preserve subprocess tests
   outside workspace dependency resolution and fixtures that exercise runtime helpers.

10. **Keep shared types independent of execution.** `@repo/gateway-types` has no package
    dependencies. Consumers can name envelopes and error codes without installing the runtime
    or generator. Parsing and `GatewayError` belong in the runtime, which re-exports shared
    types for handler authors. Preserve literal operation names in `defineGateway` types.

11. **Keep configuration environment-independent.** Do not hard-code deployed addresses,
    credentials or environment names in gateway code. Deployment-specific configuration belongs
    at the integration boundary.

## Public documentation and comments

Describe implemented behaviour and the rationale needed to maintain it. Include proposed changes
only when they explain an existing design constraint, label them clearly, and review their
relevance and security implications before publication. Keep implementation schedules and
sensitive operational details out of public contributor guidance. Preserve limitations needed
to use the code safely; do not imply that an unimplemented control provides protection.

Keep comments close to the code they explain. Prefer a short explanation of a constraint or
non-obvious decision over a roadmap, a deployment narrative or a repeat of this guide.

## Build and test notes

- `pnpm test` depends on `build`. Build and typecheck tasks also depend on dependency builds and
  codegen. A stale dependency `dist/` can mask changes; rebuild if results look inconsistent.
- Codegen has its own `^build` dependency because it reads dependencies' `dist/` exports.
  Listing both `^build` and codegen as dependencies of another task does not order them.
- Test literal operation-key inference at the type level; widening it to `string` loses useful
  information for codegen and handler authors.
