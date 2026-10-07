---
title: Conventions
description: The rules for changing the code, the tests and these docs.
---

These rules apply to every change, alongside the
[design constraints](/flex-platform/reference/design-constraints/). Work within the scope of the
change you are making.

## Code

- `packages/` holds the shared TypeScript, ESLint and Vitest configuration, and `@repo/utils`, a
  set of generic functions. Gateway code lives under `gateways/`, and what gateways share lives in
  `gateways/shared/`.
- `@repo/utils` exports one function per module. Each is imported by its own path, such as
  `@repo/utils/sorted-entries`, so a consumer takes only what it uses. Export a module once
  something outside the package uses it. Code only the package uses lives under `src/internal/`,
  which the package's exports refuse.
- Sort with `sortedNames` and `sortedEntries` from `@repo/utils`. They order by code unit, which
  gives the same result on every machine. `localeCompare`, which linters suggest for sorting
  "alphabetically", depends on the runtime's locale and ICU data. Generated files, the digests
  taken over them, and the canonical payload a secure envelope is built from must all come out the
  same every time.
- Each package owns its configuration and extends the shared tooling. Only add a root-level tool
  configuration when the tool requires one, with a comment saying why.
- Every package extends the one TypeScript base, `base.json`: strict, no emit. The documentation
  site is the exception, and extends Astro's strict base. Packages export their `.ts` sources
  directly, and Vitest, esbuild and tsx use them as they are.
- ESLint provides `base`, `driver` and `service` presets. Drivers own transport access. Services
  must use gateways. The `service` preset blocks common network globals and builtin imports, but
  it does not fully enforce network isolation, so review transport access too.
- Check installed dependencies and their APIs before using them. Keep dependency versions pinned
  exactly (`savePrefix: ""`).
- Git ignores generated artifacts, including `.gen/`, `dist/`, `.turbo/`, `cdk.out/` and
  `coverage/`. Do not commit them.
- Infrastructure follows the rules in [Infrastructure](/flex-platform/infrastructure/overview/):
  only config differs between stages, construct IDs are a contract, and stacks are wired together
  by names derived from config.
- Publishable packages use the `@govuk-once/` scope. Registry configuration is in `.npmrc`.

## Tests

- Test the libraries, not each gateway. Generation, bundling and dispatch are covered against the
  fixture gateway in `gateways/shared/codegen/test/`. A gateway package tests only its own custom
  handlers, because there will be many gateways and a deployment is what exercises each one.
- Test literal operation-key inference at the type level. Widening it to `string` loses
  information that codegen and handler authors need.

## Finishing a change

- A change is done when `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm codegen` pass. If it
  changes `docs/`, `pnpm --filter @repo/docs build` must pass too: it is the only check that finds
  a broken link.
- A pull request's title is `FLEX-<number> <type>(<scope>)?: <description>`, such as
  `FLEX-123 feat: add udp gateway`. The type is one of `feat`, `fix`, `chore`, `docs`, `style`,
  `refactor`, `test`, `perf`, `ci`, `build` or `revert`, with `!` after it for a breaking change.
  CI refuses any other title.

## Documentation and comments

These docs are the source of truth for how the platform works and the rules for changing it.
Before you change an area, read its page. If your change alters the behaviour a page describes,
update the page in the same change.

Describe implemented behaviour and the reasoning needed to maintain it. Only include proposed
changes when they explain an existing design constraint. Label them clearly, and review their
relevance and security implications before publishing.

The planned parts of the platform are described in [The platform](/flex-platform/start/platform/)
and in the Frontdoor and Domains sections. Label each one as planned, and give none a schedule.
Describe only what has been decided about them. Keep the limitations people need to use the code
safely. Never imply that an unimplemented control provides protection.

This repository is public. Anything its code shows can be described in these docs in full: leaving
it out hides it from nobody, and only makes it harder to find.

Never commit a secret value, such as a key, a token, a password or any other credential, in code,
configuration or these docs.

"Gateway" always means the egress Lambda this repository generates. Name Amazon API Gateway in
full, as "API Gateway" at the least, so the two are never confused.

Say a thing once. Describe each behaviour on the page for its area, and link to it from elsewhere
instead of repeating it. Internal links include the site's base, `/flex-platform/`, and the build
fails on a link that points nowhere.

Keep comments close to the code they explain. Prefer a short explanation of a constraint or a
non-obvious decision over a roadmap, a deployment narrative or a repeat of these docs.
