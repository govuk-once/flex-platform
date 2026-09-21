# Declare every UDP operation Flex uses, and what Flex keeps in UDP's data store

**Placeholder:** FLEX-111
**Branch:** `feat/udp-gateway-operations` (4 commits, tip of the stack)
**Depends on:** the `matches` and `narrow` ticket

## Why

The UDP gateway has been an example: one operation, a placeholder handler and schemas written by
hand. Everything the stack below this built — versioned schemas, the compatibility check, the
`gateway-schemas` command, OpenAPI derivation, `matches` and `narrow` — exists so this gateway can
be the real thing. This is the first gateway whose contract is derived from its upstream's own
document at a pinned revision.

## Scope

- Remove the placeholder `getIdentityExchange` handler, its test and the gateway's Vitest
  dependency. The gateway package tests only its own custom handlers, and it now has none; the
  libraries are tested against the fixture gateway in `gateways/shared/codegen/test/`.
- Pin `spec` to the commit UDP runs in production (release v1.54.3, 2026-08-14) rather than a
  branch: the schemas are derived from what it names, and a branch names something else tomorrow.
  Moving the pin on is how this gateway takes a newer UDP.
- Declare the nine operations UDP documents under a path of its own: `createUser`,
  `getIdentityExchange`, `getIdentity`, `createIdentity`, `deleteIdentity`, `getLinkedServices`,
  `startDsar`, `startSar`, `getSarStatus`.
- Declare the five operations on what Flex keeps in UDP's data store, which UDP describes once for
  any path and any shape (`/v1/{resourcePath+}`): notification preferences (read, replace, delete)
  and group subscriptions (read, replace). Each names its path in full, names the template as its
  `matches`, and states the shape Flex keeps there through `narrow` — that shape is Flex's to
  describe, not UDP's. **No caller chooses a path: what can be reached is what is written here.**
- Share the two "who is asking" headers as one `REQUESTING` mapping, so a caller meets the same two
  fields wherever it meets them, named as the rest of an input is and not as the headers they
  travel in. Keep what Flex stores in one module per thing stored, under `config/`.
- Regenerate `schemas/0001.json` from the pinned document. `pnpm schemas` should report `unchanged`
  for udp at this commit.

## Acceptance criteria

- [ ] `pnpm schemas` reports `unchanged` for the udp gateway against the pinned spec.
- [ ] `pnpm codegen` generates validators, entry point, bundle and call contract for all fourteen
      operations.
- [ ] Every data-store operation names its full path and its `matches`; none takes a path segment
      from a caller.
- [ ] The udp package has no handlers, no Vitest dependency and no test script.
- [ ] `gateways/README.md` no longer refers to the removed handler as an example.

## Notes

`auth` stays `noAuth()`: this upstream takes no credential yet, and the deployment still names a
secret, which must be the empty object. A login flow replaces that definition when UDP gets one.
Whether this gateway should move to `sigV4` is a deployment question, not this ticket's.
