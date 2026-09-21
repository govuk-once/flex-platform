# Keep a gateway's schemas as versioned data beside its configuration

**Placeholder:** FLEX-111
**Branch:** `feat/gateway-schema-store` (5 commits, first in the stack)
**Depends on:** nothing — branches from `feat/generic-utils`

## Why

A gateway's schemas were a TypeScript fixture, `schemas.fixture.ts`, imported by codegen. Three
things follow from that and all of them are wrong. Importing evaluates: reading a gateway's
schemas ran its code. A module can only describe the configuration as it is now, so no earlier
state of the contract is readable, and nothing can be compared across time. And a fixture is
named as a stand-in for something a driver would produce later, which is not what it is: the
schemas are the gateway's contract with its callers and belong under review as data.

This ticket replaces the fixture with a versioned store on disk. It delivers no new capability on
its own; it is what the compatibility check, the `gateway-schemas` command and everything derived
from an upstream are built on.

## Scope

- A `schemas/` directory beside each gateway's configuration, JSON files numbered from `0001.json`,
  four digits, no gaps. Codegen generates from the highest-numbered version.
- A version holds shared `defs` and, per operation, an `input` schema and a schema per outcome.
- A version is parsed, never imported. Its shape is checked on read, with everything wrong in a
  version reported in one run rather than the first failure.
- Refuse an unknown field (a misspelling would otherwise be silently ignored) and refuse
  `__proto__` as a definition, operation or outcome name.
- A directory holding anything but the numbered versions, or whose numbering has a gap, fails
  generation rather than being read around.
- Restate the UDP gateway's and the codegen fixture gateway's schemas as `0001.json`, delete both
  `schemas.fixture.ts` files and the loader's fixture path.
- Remove the `deriveSchemas` hook from the driver definition: nothing called it, and the command
  added later takes a different shape (see the deriving ticket).

## Acceptance criteria

- [ ] `pnpm codegen` generates from `schemas/<highest>.json` for every gateway; no gateway package
      contains a schema fixture module and nothing imports one.
- [ ] Reading a version evaluates no gateway code.
- [ ] A version with a misspelt field, a `__proto__` key, a malformed directory or a gap in the
      numbering fails with a message naming what and where; multiple faults are reported together.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm codegen` pass at this commit.

## Out of scope

Comparing versions with each other (next ticket), and producing a version from anything but a
person's hand.
