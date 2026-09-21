# Bring a gateway's schemas up to date from its upstream's own description

**Placeholder:** FLEX-111
**Branches, in order:** `feat/gateway-schemas-update` (6 commits) →
`feat/openapi-rest-derive-schemas` (5 commits)
**Depends on:** the call contract ticket

## Why

A gateway's schemas were written by hand against an upstream's documentation, which means they
were wrong the moment the upstream moved and nobody could tell which way. The upstream already
describes itself: `openapi-rest` gateways name an OpenAPI document as their `spec`. Deriving the
schemas from it makes the gateway's contract traceable to a pinned upstream revision, and makes
the compatibility check meaningful, because it is now comparing what the upstream actually said
at two points in time.

Two PRs: the driver-neutral command, then the `openapi-rest` implementation of it.

## Scope

### `gateway-schemas`, the command

- A second CLI in `@repo/gateway-codegen`, run in a gateway package as `gateway-codegen` is, with
  `pnpm schemas` running it for every gateway through turbo and carrying on past one that fails.
- **A person runs it, reads what it says and commits what it wrote. It reaches the network, so
  nothing runs it in CI** — there, codegen's comparison of the committed versions is what holds.
- A driver that can derive its schemas names the module that does, as `deriveSchemasModule` on its
  definition. It is a **name and not an import**: a generated entry point imports the configuration
  and the bundler follows every import it can see from there, a dynamic one included, so an import
  would carry whatever parses the upstream's description into the deployed gateway. The command
  resolves the name from the gateway's own directory. This lands in design constraint 1.
- The module's default export is called with the configuration and one thing it may read a
  description through: `load`, which fetches over https following no redirect, or reads a path
  within the gateway's directory.
- What comes back is held to everything a version on disk is held to — the shape, each schema
  compiling as the validators compile it, agreement with the configuration — before it is compared
  with the latest version. Then:

  | Upstream | What the command does |
  |---|---|
  | Shape unchanged | Writes nothing. A reworded `description` is not a change of shape, so the contract's comments can lag the upstream's until its shape next changes. |
  | Changed, no caller breaks | Writes the next version, in the order it was derived in, and lists the changes. |
  | A change would break a caller | Writes nothing, says so loudly with every break, and fails. |
  | No versions yet | Writes `0001.json`. |

- A version is two-space JSON in source order, nothing a formatter decides, so the same schemas are
  the same bytes whatever is installed. It is linked into place rather than renamed, so a version
  that exists is never written over.
- A gateway whose driver derives nothing keeps its versions by hand; the command checks them as
  codegen does and writes none.

### Deriving from an OpenAPI document

- `src/derive/` in `openapi-rest`, named by the definition and imported by nothing a gateway
  reaches, with a lint rule keeping it that way, so the parser is never part of a deployed gateway.
- `@scalar/openapi-parser` parses JSON or YAML, checks the document and rewrites OpenAPI 3.0's
  dialect as 3.1's, which is JSON Schema 2020-12.
- Only the operations the configuration declares are derived, each found by its `upstream` method
  and path. An `operationId` is not used: a document need not have one, and one it has need not be
  a name.
- Parameters become input fields under the configuration's name for them; a required parameter
  nothing maps fails the run, an optional one is left out with a note. A request body becomes
  `payload`, always required, JSON only. 200/201/202/204 become the outcome the driver maps that
  status to, a 204 or a bodiless success as `null`. 4xx, 5xx and `default` derive nothing: they
  reach a caller as error codes. `#/components/schemas/Name` becomes the shared definition `Name`,
  keeping only those an input or outcome reaches. `security` derives nothing.
- Share the statuses the driver already maps as outcomes rather than restating them.
- **The two sides of a call are converted differently, and this is the point of the ticket**
  (design constraint 14):

  | | Input | Outcome |
  |---|---|---|
  | An object that says nothing of other fields | Closed. One inside a composition is left open with a note, since closing one part would refuse the fields the others declare. | Left open, and one the document closes is opened. |
  | `enum` | Kept exactly. | The values it knows of beside the type admitting the rest. `const`, and a single value telling a union's branches apart, are never opened. |
  | Bounds, `pattern`, `format` | Kept exactly. | Dropped. |
  | A definition both sides use | Takes `NameInput` where the two sides hold it differently. | Keeps the document's name. |

  The reason is the direction each can move without breaking a caller: an input can be loosened
  later and never tightened, and an upstream adds fields, values and length to what it sends
  without asking. Making an outcome stricter turns a minor release upstream into a failed response
  in production; making an input looser cannot be undone.
- What JSON Schema has no keyword for is left out (`example`, `xml`, `externalDocs`,
  `discriminator`, `x-`); `nullable` with no type beside it is dropped; a schema whose keywords are
  one type's and which declares none is given it; a keyword the declared type says nothing about is
  dropped. Each is noted in what the command prints, and everything that cannot be derived at all
  is reported together and fails the run.

## Acceptance criteria

- [ ] `pnpm schemas` derives, checks and writes the next version for a gateway whose upstream
      changed safely; writes nothing when the shape is unchanged; fails loudly, writing nothing,
      when a change would break a caller.
- [ ] Nothing in `src/derive/` is reachable from a gateway's entry point; the lint rule and the
      bundle both prove it.
- [ ] Deriving the same document twice produces byte-identical output.
- [ ] Input and outcome conversion behave as the table says, each rule covered by a test.
- [ ] `pnpm schemas` is documented as a by-hand command that must not run in CI.

## Notes

`spec` is an https URL, best pinned to a release, or a path within the gateway's directory. The
document itself is never committed — only what is derived from it.
