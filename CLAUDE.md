# CLAUDE.md

Flex is the platform behind the GOV.UK app. This repository holds its egress section, the gateway
libraries and shared development tooling, and, under `platform/`, the CDK that deploys the
platform's own infrastructure, so far the front door. The rest of the platform is planned, and
`docs/src/content/docs/start/platform.mdx` describes it.

The documentation site in `docs/src/content/docs/` is the source of truth for how the platform
works and the rules for changing it. The pages below hold the rules every change follows, and are
imported here so they are always in context:

@docs/src/content/docs/start/working-in-the-repo.md
@docs/src/content/docs/start/conventions.md
@docs/src/content/docs/reference/design-constraints.md

## Left to a person

- Run `pnpm schemas` only when asked. It reaches the network and writes schema versions, and a
  person reviews what it writes.
- Never add the `schema-history-override` label to a pull request. It exists so that a person
  decides to change a merged version.

## Reading the site

A link on the site such as `/flex-platform/gateways/overview/#a-request` is the file
`docs/src/content/docs/gateways/overview.md` (or `.mdx`), at that heading. The home page,
`/flex-platform/`, is `index.mdx`. Before you change an area, read its page:

| Area | Page |
|---|---|
| The platform's sections | `start/platform.mdx`, `frontdoor/`, `domains/` |
| What is implemented and what is planned | `start/platform.mdx` |
| Packages and what each holds | `reference/packages.md` |
| How a gateway works, dispatch order | `gateways/overview.md` |
| Configuration, policy, logging, bindings | `gateways/configuration.md` |
| Schema versions and `gateway-schemas` | `gateways/schemas.md` |
| Deriving schemas, from a description or the configuration | `drivers/contract.md`, `codegen/checks.md` |
| Compatibility between versions | `gateways/compatibility.md` |
| Envelopes, `meta`, error codes, health | `gateways/responses.md` |
| Codegen output, checks, entry point, bundle, contract | `codegen/` |
| The driver contract, and writing a driver | `drivers/contract.md`, `drivers/writing-a-driver.md` |
| The openapi-rest driver | `drivers/openapi-rest/` |
| Environment variables and the secret | `reference/environment.md` |
| Terms | `reference/glossary.md` |

The CDK package under `platform/` is described in `platform/README.md`: its stacks, the regions
they must be in, the parameters they read and write, and what has to exist before a deploy.
`pnpm synth` synthesises it for the stage in `STAGE` without AWS access; `pnpm checkov` scans
what it synthesised.
