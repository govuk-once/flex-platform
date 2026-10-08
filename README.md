# Flex Platform

Flex is the platform behind the GOV.UK app. It connects what GOV.UK knows about a user with the
government services the app is built to work with.

This repository holds the Flex gateways: the libraries, drivers and code generation that give
domains a typed, validated way to reach the upstreams they depend on.

**Documentation: <https://govuk-once.github.io/flex-platform/>**, built from [`docs/`](docs/).

## Working in this repo

Use Node 24 and the pnpm version pinned in `package.json`.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm codegen
pnpm test
pnpm --filter @repo/docs dev   # the documentation site, with live reload
```

See [Working in the repo](https://govuk-once.github.io/flex-platform/start/working-in-the-repo/)
for setup, [Conventions](https://govuk-once.github.io/flex-platform/start/conventions/) for the rules
for changing the code, and
[Design constraints](https://govuk-once.github.io/flex-platform/reference/design-constraints/) for
the boundaries every change keeps.

The `.npmrc` maps the `@govuk-once` scope to GitHub Packages. Do not commit registry credentials.

## Licence

MIT. See [LICENCE](LICENCE).
