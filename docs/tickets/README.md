# The FLEX-111 stack, as tickets

Every commit from `0b635dd` (tip of `feat/generic-utils`) to the tip of
`feat/udp-gateway-operations` is prefixed `FLEX-111`, a placeholder for tickets that did not exist
yet. Eleven stacked PRs, grouped here into eight tickets. Fill the code column in, and the commit
prefixes and PR titles can be rewritten per branch.

| # | Ticket | Branches (in stack order) | Commits | Code |
|---|---|---|---|---|
| 01 | [Versioned schema store](01-versioned-schema-store.md) | `feat/gateway-schema-store` | 5 | FLEX-___ |
| 02 | [Compatibility between schema versions](02-schema-compatibility.md) | `feat/gateway-schema-compatibility` | 4 | FLEX-___ |
| 03 | [Call contract types and documentation](03-call-contract-types-and-docs.md) | `feat/gateway-contract-closed-types`, `feat/gateway-contract-docs`, `feat/gateway-contract-open-enums` | 8 | FLEX-___ |
| 04 | [Derive schemas from the upstream](04-derive-schemas-from-upstream.md) | `feat/gateway-schemas-update`, `feat/openapi-rest-derive-schemas` | 11 | FLEX-___ |
| 05 | [Response metadata](05-response-metadata.md) | `feat/gateway-response-meta` | 4 | FLEX-___ |
| 06 | [SigV4 authentication](06-sigv4-authentication.md) | `feat/openapi-rest-sigv4-auth` | 4 | FLEX-___ |
| 07 | [`matches` and `narrow`](07-path-templates-matches-and-narrow.md) | `feat/openapi-rest-matches-and-narrow` | 4 | FLEX-___ |
| 08 | [UDP gateway operations](08-udp-gateway-operations.md) | `feat/udp-gateway-operations` | 4 | FLEX-___ |

Each branch is stacked on the one before it, so the tickets are delivered in this order and each
depends on the one above. They are not independently mergeable.

## Why these groupings

- **01 and 02 are separate** because the store is a refactor with no new behaviour and the
  comparison is the rule it enables; either could be reviewed without the other in mind.
- **03 is one ticket over three PRs**: all three change the emitted call contract, and the
  documentation work is what makes the text-safety work necessary.
- **04 is one ticket over two PRs**: the command and the first driver implementation of it. Neither
  delivers the capability alone.
- **05, 06 and 07 are each one PR** and each a distinct capability with its own design constraint
  (`meta`, what an authentication is shown, no caller chooses a path).
- **08 is the gateway that all of it was for**, and the only ticket that changes a service.
