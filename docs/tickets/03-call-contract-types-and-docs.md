# The generated call contract describes what the schemas say, and carries their text safely

**Placeholder:** FLEX-111
**Branches, in order:** `feat/gateway-contract-closed-types` (2 commits) →
`feat/gateway-contract-docs` (4) → `feat/gateway-contract-open-enums` (2)
**Depends on:** the schema compatibility ticket

## Why

The call contract in `.gen/client/` is what a consuming service compiles against, so its types and
its comments are the whole of what a caller knows about a gateway. Three things were wrong with it,
and all three become worse the moment schemas are derived from an upstream's own document rather
than written by hand:

1. Every object the schema did not explicitly close got an index signature, so the type offered
   fields nobody declared. Outcome schemas are deliberately left open so an upstream can add a
   field without failing its responses — which meant nearly every response type was `{ ... } &
   Record<string, unknown>`.
2. Nothing a schema said about itself reached the caller. The descriptions are the documentation,
   and an editor showed none of it.
3. An outcome that lists the values it knows of while admitting others compiled to `string`,
   losing the values.

Once descriptions come from an upstream's document, that text is **data from outside this
repository written into code a caller compiles**. It has to be treated as such. This is the ticket
where that becomes a design constraint (13 in `CLAUDE.md`).

## Scope

**Types that match the schemas**

- Describe an object by the fields it declares and no others, unless the schema says it holds more:
  `additionalProperties: true`, a schema for the rest, or `patternProperties`. Leaving
  `additionalProperties` out no longer produces an index signature.
- Document the asymmetry: to a validator, leaving it out admits every other name exactly as `true`
  does, and that is what keeps an outcome valid when the upstream adds a field. What an upstream
  adds still reaches a caller, unvalidated and undeclared. `additionalProperties: false` is still
  worth setting on an **input**, because there the validator is what decides and a field no
  `parameters` entry maps fails the request as `INTERNAL`.

**Documentation in the contract**

- Emit a `description`, or a `title` where there is none, in front of each shared definition, each
  field and each outcome, with `@deprecated` where the schema sets `deprecated`. A field that only
  refers to a definition takes the definition's text, since an editor shows a field's comment and
  not its type's. An operation takes the `description` from its configuration.
- Add `docComment`, the only route from schema text to a comment: it keeps `*/` from ending the
  comment, keeps a line beginning with `@` from being read as a tag, and writes each line of the
  text on a line of its own inside one block, since the compiler attaches nothing to a comment
  sharing a line with the token before it.
- Names and values reach generated code through `JSON.stringify` or `assertIdentifier`, never by
  interpolation.
- Refuse characters that do not display anywhere in a version of the schemas, in names and values
  alike — control characters and the format characters that reorder or hide surrounding text —
  read from the parsed value, so one written as a `\u` escape is caught too. A version is reviewed
  by a person; one of these would let it show a reviewer one thing and hold another.

**Values an outcome knows of**

- Emit `anyOf: [{ "enum": ["Valid", "Revoked"] }, { "type": "string" }]` as
  `"Valid" | "Revoked" | (string & {})`. Written with a bare `string`, TypeScript reads the whole
  union as `string` and forgets the values. With this, a caller's editor offers them, a switch does
  not compile without a `default`, and that branch is where a value added later arrives — so adding
  one breaks no caller, which is what the compatibility check already assumes.
- An `enum` on its own stays the closed union it is, which is what an input wants.

## Acceptance criteria

- [ ] A response type lists the declared fields only; an index signature appears only where the
      schema says the object holds more.
- [ ] Descriptions, titles and `@deprecated` appear in the emitted contract and in a caller's editor.
- [ ] A contract built from hostile schema text — `*/`, a leading `@`, newlines, a would-be
      identifier — compiles, and a test proves the comments can carry a real tag at all. Keep both.
- [ ] A version containing a non-displaying character is refused when read.
- [ ] A known-values union keeps its values in the emitted type and still admits any string.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm codegen` pass at each commit.

## Notes

These are three PRs because each is separately reviewable, not because they can ship apart: the
documentation work is what makes the text-safety work necessary, and the known-values union is what
the outcome side of schema derivation emits.
