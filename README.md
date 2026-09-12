# Flex Platform

Gateway libraries and shared development tooling for the Flex Platform.

## Layout

```txt
gateways/shared/     Configuration, shared types, runtime and validator generation
gateways/services/   Gateway configurations and schema fixtures
packages/           Shared TypeScript, ESLint and Vitest tooling
```

Gateway-specific libraries live under `gateways/shared/`. The `packages/` directory contains
tooling shared across the repository.

## Gateways

A gateway groups operations for one upstream. Configuration describes those operations; shared
libraries handle schema validation, dispatch, upstream timeouts and payload logging. This keeps
transport-specific details separate from common runtime behaviour.

The repository includes `defineGateway`, a dispatcher and a generator that emits standalone
JavaScript validators from schema fixtures. It does not yet provide a complete deployable gateway
or generated client. Authentication is not implemented, and only the upstream-timeout policy is
enforced. See [the gateway guide](gateways/README.md) for supported behaviour and limitations.

## Working in this repo

Use Node 24 and the pnpm version pinned in `package.json`.

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

Turborepo coordinates package tasks. Use `pnpm --filter <package> <script>` to run a package's
script directly. Generated files and build output are ignored by Git.

The `.npmrc` maps the `@govuk-once` scope to GitHub Packages. Authentication is needed when
accessing packages that require it; do not commit registry credentials.

Contributor conventions and design constraints are in [CLAUDE.md](CLAUDE.md).

## Licence

MIT. See [LICENCE](LICENCE).
