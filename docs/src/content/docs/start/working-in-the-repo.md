---
title: Working in the repo
description: Commands, setup and conventions for contributors.
---

Use Node 24 (`.nvmrc`) and the pnpm version pinned in the root `package.json`. Turborepo runs the
package tasks.

```bash
pnpm install          # link the workspace and install dependencies
pnpm lint             # eslint, all packages
pnpm typecheck        # tsc --noEmit, all packages with a typecheck script
pnpm codegen          # generate gateway validators, Lambda bundles and call contracts
pnpm schemas          # bring each gateway's schemas up to date with its upstream; by hand, never in CI
pnpm test             # vitest run, all packages
```

Run one package's script with `pnpm --filter <name> <script>`. For example:

```bash
pnpm --filter @govuk-once/flex-gateway-udp codegen
```

The CDK app synthesizes one stage at a time. See
[Infrastructure](/flex-platform/infrastructure/overview/).

Use pnpm and the existing scripts. When a tool has no package script, use `pnpm exec`. Do not use
`npx`, `npm`, `yarn` or `pnpx`.

## Things to know

- TypeScript is strict, and also turns on `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. An indexed read may be `undefined`, and an optional property
  cannot be set to `undefined` explicitly.
- Vitest runs with `globals: false`, so import `describe`, `it` and `expect` in every test file.
- Dependency versions are pinned exactly. pnpm refuses any release less than seven days old.

## No library build step

Library packages have no separate compilation step. Codegen emits validators and call contracts,
then bundles the generated entry point with esbuild, so a gateway that cannot be bundled fails
generation. The documentation site has its own Astro build.

Workspace packages export their `.ts` sources and resolve to each other's sources. This means
typecheck and tests see a dependency change immediately, and no task waits on another package.
Vitest, esbuild and tsx use the sources as they are.

Git ignores generated artifacts: `.gen/`, `dist/`, `.turbo/`, `cdk.out/` and `coverage/`.

## The documentation site

This site lives in `docs/` and is built with Astro and Starlight.

```bash
pnpm --filter @repo/docs dev      # serve with live reload
pnpm --filter @repo/docs build    # build to docs/dist/, failing on a broken internal link
```

Internal links include the site's base path, `/flex-platform/`. A pull request that changes
`docs/` builds the site. A merge to `main` publishes it to GitHub Pages.

## Rules for changing the code

[Conventions](/flex-platform/start/conventions/) covers where code belongs, what to test and how to
keep these docs. [Design constraints](/flex-platform/reference/design-constraints/) lists the
boundaries whose violation goes unnoticed. Both apply to every change.
