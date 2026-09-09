# CLAUDE.md

The source of convention for AI agents in this repository, and a reference for humans. Read it
before making changes.

Much of what is described here has not been built yet. This file explains how the pieces are
meant to fit together so that whatever you build next fits with them. It is not a work queue. Do
not start building an unbuilt package because it is listed here. The developer working with you
decides what gets added and when, so if the scope of a request is unclear, ask.

## What this is

`gateways/` is the only top-level area so far, and is the focus of everything below. Others will
be added as sibling top-level directories. Each shares the toolchain in `packages/` but owns its
own code and lifecycle. Keep code inside the area it belongs to. `packages/` is only for tooling
shared across all of them.

### Gateways

A set of internal services ("gateways") that mediate all access to upstream APIs. Each gateway
owns exactly one upstream. Consumers get a stable typed RPC interface and never talk to an
upstream directly.

The concept is simple. You write a `gateway.config.ts` and codegen tooling produces the rest. All
the complexity lives behind that tooling rather than in the gateway you author: resilience
(timeouts, retries, circuit breaking, rate limits), credential custody, contract validation and
error normalisation. Keep it that way. If a change pushes complexity back out into the authoring
surface or the consumer surface, it is probably wrong.

- There is no HTTP anywhere in this design. Consumers invoke gateways via `lambda:InvokeFunction`
  (`RequestResponse`), in-VPC. One Lambda per upstream.
- Upstreams are data rather than code. A small set of drivers interprets config. `openapi-rest` is
  the currently the only driver to be built. A new transport means a new driver package, never a
  change to the runtime.
- Everything that is publishable is published under the `@govuk-once/` scope to GitHub Packages.

## Current state

The repo is early. Most packages named in this file do not exist yet.

What exists today:

- `packages/tsconfig`, `packages/eslint-config`, `packages/vitest-config`: shared tooling.
- `gateways/shared/config` (`@repo/gateway-config`): `defineGateway`, types, presets.
- `gateways/services/udp` (`@govuk-once/flex-gateway-udp`): the first real gateway, with a
  `gateway.config.ts` pointing at the User Data Platform upstream.

## Future work

Nothing here is scheduled. It is listed so you understand what the current code is making room
for.

Needed for a gateway to run end to end:

- `gateways/shared/runtime` — `flex-gateway-runtime`
- `gateways/drivers/openapi-rest` — `flex-gateway-driver-openapi-rest`
- `gateways/shared/codegen` — `flex-gateway-codegen`
- `gateways/shared/client` — `flex-gateway-client`
- the `udp` gateway's end-to-end test

Further out:

- CDK and infrastructure
- Real JWT verification
- Working breaker, limiter, retry and budget, plus a Valkey `PolicyStore`
- `testkit`
- Contract snapshots, the differ and `published/`
- Generated types and a generated client package

## Commands

Run from the repo root. Turborepo orchestrates per-package tasks.

```bash
pnpm install          # link workspace; run after adding/removing a package
pnpm lint             # eslint, all packages
pnpm typecheck        # tsc --noEmit, all packages
pnpm build            # tsc --build per package (depends on ^build + codegen)
pnpm test             # vitest run (depends on build)
```

Per package: `pnpm --filter <name> <script>`.

Never use `npx`, `npm`, `yarn` or `pnpx`. They are denied. Aim to use the built
in scripts where possible otherwise use `pnpm exec`.

## Toolchain

| | |
|---|---|
| Runtime | Node 24 (`.nvmrc`), ESM throughout, async handlers only |
| Language | TypeScript `strict: true`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` |
| Package manager | pnpm workspaces (version pinned in root `packageManager`) |
| Task runner | Turborepo |
| Bundler | esbuild (`format: esm`, `platform: node`, `target: node24`); not wired yet |
| Tests | Vitest (`globals: false`; import `describe`/`it`/`expect` explicitly) |
| Validation | Ajv standalone mode for contracts; Zod 4 for authoring escape-hatch handler schemas |
| JWT | `jose` (currently not implemented) |
| Logging | pino, with a default-deny allowlist serializer |

Do not guess dependency versions or APIs. Check what is installed, or ask. Version pins are exact
(`savePrefix: ""`). Keep them exact.

## Repository conventions

- Configuration is per package. Every package owns its own `tsconfig.json`, `eslint.config.ts` and
  `vitest.config.ts`, each extending a shared base from `packages/*`. There is no root-level
  tsconfig, eslint or vitest config. Add a root-level tool config only if a tool genuinely cannot
  function otherwise, with a comment saying why.
- Where code lives: anything gateway-specific goes under `gateways/`, with services in
  `gateways/services/`, drivers in `gateways/drivers/`, and core libraries in `gateways/shared/`.
  Root `packages/` is reserved for tooling shared across the whole repo (tsconfig, eslint, vitest).
  A library used only by gateways does not belong in `packages/`, even when it looks generic.
- tsconfig bases: `base.json` (noEmit, strict), `library.json` (emits `.d.ts` plus maps, for
  shared packages), `lambda.json` (emits JS, no declarations, for services).
- ESLint presets (`@repo/eslint-config`): `base`, `driver`, `service`. `driver` extends `base`
  with no network restrictions (drivers own their transport). `service` extends `base` and bans
  raw `fetch`, `node:http`, `node:https` and `undici` (services must go through a gateway).
  Driver and service packages must use the `driver` or `service` preset.
- Generated and build artifacts are gitignored: `.gen/`, `dist/`, `*.tsbuildinfo`, `.turbo/`,
  `cdk.out/`, `coverage/`. Do not commit them. The only committed generated artifact will be
  `published/`, once contract publishing exists.

## Load-bearing invariants

These are the rules whose violation is silent. The build stays green while the thing quietly
breaks. Treat them as non-negotiable unless a change is explicitly agreed. Several describe
behaviour of code that does not exist yet, so read them as constraints on how it gets built.

1. The driver seam is transport-neutral. `flex-gateway-runtime` and `flex-gateway-codegen` must
   never know about paths, HTTP methods, status codes or headers. Those live only inside a driver.
   Contracts cross the seam as JSON Schema, and driver-private state is opaque. If the runtime or
   codegen starts needing HTTP vocabulary, the seam has broken. Stop and fix it rather than routing
   around it. Grep both once the driver work is done.

2. Drivers own their transport. The runtime has no knowledge of HTTP, fetch, or any specific
   network library. A driver chooses its own mechanism (fetch for REST, the AWS SDK for DynamoDB,
   etc.) and wraps each upstream call in `ctx.attempt(fn)`. One `ctx.attempt` is one metered upstream
   unit — the runtime applies timeout, retry and breaker around whatever `fn` does. Raw network
   access in a service is still banned (ESLint enforces it via the `service` preset); in a driver
   it is expected, but must go through `ctx.attempt` so that policies apply.

3. The dispatcher order is fixed. Parse envelope, verify token (stubbed for now, but keep the call
   site wired), route on `op`, validate input (`INVALID_INPUT`, no upstream call), check `secure`
   bindings (`SECURE_VALUE_MISMATCH`), derive deadline, run pipeline, validate the outcome payload
   (`UPSTREAM_CONTRACT_VIOLATION`), record health, wrap envelope. Config is validated at module
   load, so a malformed policy fails cold start. Unknown `op` returns `OPERATION_NOT_FOUND` in the
   envelope, and any uncaught error returns `INTERNAL`. Nothing throws out of the handler except
   genuine crashes.

4. Failures are data on the wire and typed errors at the consumer. The response envelope carries
   `{ ok: false, error }`, and the client turns that back into a thrown typed error. Success
   payloads are named outcomes with a uniform `{ outcome, data }` wrapper, even for single-outcome
   operations, so an upstream field named `outcome` cannot collide with the discriminant.

5. The error taxonomy declares health semantics per code, as data. Adding a code forces you to
   state what it means for the breaker. Two non-obvious rulings: `NOT_FOUND` and
   `UPSTREAM_REJECTED` count as upstream success, because that is a healthy upstream answering
   correctly and counting them as failures trips breakers during 404 bursts. `UPSTREAM_CONTRACT_VIOLATION`
   counts as upstream failure. The breaker gates in-pipeline (fast-fail while open) but records at
   the top level after output validation.

6. Logging is default-deny. Nothing from an upstream payload is logged unless named in an
   operation's `log.fields`. A new upstream field must never be able to become a new log leak.
   Tests grep captured output for secrets, tokens and unallowlisted fields.

7. Contracts are additive-only. The contract only ever grows and there is no breaking-change path.
   A genuinely breaking change means a new gateway (`udp-v2`) rather than a version bump. The
   differ, when it exists, compares against every published version and fails closed on any
   construct it does not recognise.

8. Client `maxAttempts: 1` on the SDK, non-negotiable. The AWS SDK otherwise retries 5xx and
   throttling with no idempotency awareness, turning one slow-but-successful invoke into two
   upstream writes. Retries belong in the gateway, where the budget lives. It looks like an
   oversight, so keep the source comment explaining why.

9. The client stays thin. `flex-gateway-client` must not transitively pull in the runtime, drivers
   or codegen. Consumers ship types only, with no Ajv and no schemas, because the gateway has
   already validated.

10. Nothing in code names an environment. Function names compose from an env-var prefix plus
    gateway id at module load. A deployed name containing `dev` is a fact about the deployment
    rather than the code.

## Environment variables

All gateway runtime env vars use the prefix `FLEX_GATEWAY_`. Each gateway is its own Lambda, so
the same var name resolves to different values per deployment.

| Variable | Purpose |
|---|---|
| `FLEX_GATEWAY_BASE_URL` | Upstream base URL. Set per environment by infra. Never in code or config. |

The gateway config (`gateway.config.ts`) is environment-free. It declares the upstream spec
(pinned to a known commit/ref) and operations, but never URLs, credentials or anything that
varies between environments. Those come from env vars resolved at cold start.

## Suggested build order

If and when the walking skeleton gets picked up, this is the order that keeps something runnable
at every step. Treat it as a map rather than a plan. Step 6 is the risky one, so build the seams
between packages rather than building packages to completion in isolation.

1. Scaffolding: root files, three shared tooling packages and empty workspace packages.
2. `flex-gateway-config`: types, `defineGateway` (must preserve literal types for operation keys),
   presets, type-level tests. Zero runtime dependencies.
3. `codegen` (partial): `loadConfig` (jiti, no build step), `emitValidators` (Ajv standalone).
   Reads config and emits JSON Schema validators. This is the phase-1 checkpoint: a real
   `gateway.config.ts` produces validated schemas before runtime internals exist. `emitEntry`
   lands later once runtime types are available.
4. Runtime skeleton: envelope, error taxonomy with health metadata, dispatcher steps 1 to 6 plus
   10, stub driver.
5. Driver seam and `ctx.attempt`: `DriverContext`, policy-wrapped `ctx.attempt`, in-memory
   `PolicyStore`, pipeline with pass-through stages. Only the timeout needs to be real at first,
   but composition and ordering have to be correct from the start. The stage bodies can land later.
6. `openapi-rest` (`gateways/drivers/openapi-rest`): build-time schema emission first, then the
   runtime path.
7. `codegen` (complete): `emitEntry`. Wire validation into dispatcher steps 4 and 8.
8. `client`: invoke wrapper and error classes.
9. `udp`: config, local HTTP stub and an end-to-end test through the real dispatcher and driver.

The target is one gateway, one operation, running end to end against a stubbed upstream and
exercised by tests, with no AWS, no network and no infrastructure. That is reached when
`pnpm test` passes from a clean clone with no AWS credentials and no network; a test drives the
real dispatcher through the real `openapi-rest` driver against a local HTTP stub and gets
`{ outcome, data }`; input, outcome, secure and error-taxonomy behaviour all match the invariants
above; a driver provably cannot reach the network outside `ctx.attempt`; no secret appears in logs;
esbuild bundles the generated entry point; and every package has its own tsconfig, eslint and
vitest config.

## Gotchas

- Tests use `globals: false`. Import from `vitest` explicitly.
- `pnpm test` depends on `build`, and `build` and `typecheck` depend on `^build` plus `codegen`. A
  stale `dist/` in a dependency can mask changes, so rebuild if results look wrong.
- Keep `CHANGELOG.md` and `published/**` out of `build.inputs` in `turbo.json`, or every release
  busts the cache.
- `codegen` depends on `^build` in `turbo.json` because it reads dependencies' `dist/`. Without
  that dependency it could run before those packages build, since `build` depending on both
  `^build` and `codegen` does not order the two against each other.
- `defineGateway` returning a widened type (`string` instead of the literal operation-key union)
  silently breaks downstream codegen typing. This is load-bearing, so assert it at the type level.
