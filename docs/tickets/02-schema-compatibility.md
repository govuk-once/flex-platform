# Fail generation when a version of a gateway's schemas breaks its callers

**Placeholder:** FLEX-111
**Branch:** `feat/gateway-schema-compatibility` (4 commits)
**Depends on:** the versioned schema store ticket

## Why

"Changes to an established gateway contract must be additive" was a design rule with nothing
behind it. A caller written against one version of a gateway has to survive the next, and the
cost of noticing a break late is paid by every caller. Now that versions are kept side by side,
codegen can hold each one to the one before it.

## Scope

- Load every version in a gateway's `schemas/`, not only the latest.
- Compare each version with the one before it, all the way back, and fail codegen when any step
  would break a caller. Reading only the last step would let two versions added together hide a
  break in the first.
- The two sides of a call run in opposite directions:
  - **Input** breaks by admitting less: a field that becomes required or is removed, a narrower
    type, a removed `enum` value, a tighter bound, a new `pattern` or `format`, an object that
    closes. Admitting more is safe.
  - **Outcome** breaks by promising less: a removed field, a field that stops being required, a
    wider type, an added `enum` value, a looser bound. Promising more is safe.
  - A removed operation breaks. A removed **or added** outcome breaks, because a caller's switch
    over the outcomes was complete.
  - A removed or replaced shared definition breaks, since the contract exports each as a named type.
- Annotations (`description`, `title`, `deprecated`, `examples`) and the order anything is written
  in are not differences. A definition is compared once for each direction it is used in.
- `allOf`/`anyOf`/`oneOf` are read branch by branch. Anything the comparison cannot place counts as
  a break: a safe change refused costs a look, an unsafe change accepted costs every caller.
- Document the rule and its limits: nothing compares the generated types across a change to the
  generator, nor the error codes. A contract that has to break takes a gateway of its own, under
  another id. This lands as design constraint 7 in `CLAUDE.md`.

## Acceptance criteria

- [ ] Codegen fails, naming the version, the operation and the keyword, for each breaking change in
      the table above, whether it is in the last step or an earlier one.
- [ ] Each safe change generates without complaint.
- [ ] A keyword the comparison does not understand fails rather than passing.
- [ ] The rule and what it does not cover are written in `gateways/README.md` and `CLAUDE.md`.

## Notes

Subsumption between JSON Schemas is not decidable in general and this does not attempt it. The
check is a conservative reading of the keywords, by design.
