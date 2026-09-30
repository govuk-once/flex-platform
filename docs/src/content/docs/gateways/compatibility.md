---
title: Compatibility between versions
description: The rules codegen uses to compare each schema version with every version before it.
---

A caller written against one version must keep working with every version after it. So codegen
compares each version with every version before it: `0003` with `0002` and `0001`, `0002` with
`0001`. It fails if any of them would break a caller.

Comparing each version only with the one before it is not enough. A
[`meta`](/flex-platform/gateways/responses/#response-metadata) name can be removed in one version
and added back with another type in the next. Each step is safe, but a caller of the version
before the removal breaks. Comparing only the latest version is not enough either: if two versions
were added together, a break in the first would be missed.

A break is reported once, against the latest version it breaks, with the pair it lies between:
`0001 -> 0003: meta.requestId.type: changed from string to integer`.

If a version that is not merged yet breaks a caller, fix it, or remove it and renumber the versions
after it. If a contract has to break, it needs a new gateway with a different `id`.

Inputs and outcomes run in opposite directions. An input can safely admit more. An outcome can
safely promise more.

| | Breaks a caller | Safe |
|---|---|---|
| Input | Admitting less: a field that becomes required or is removed, a narrower type, a removed `enum` value, a tighter bound, a new `pattern` or `format`, an object that closes | Admitting more: a new optional field on a closed object, a wider type, an added `enum` value, a looser bound |
| Outcome | Promising less: a field that is removed or stops being required, a dictionary that closes, a wider type, an added `enum` value, a looser bound | Promising more: an added field that no dictionary already covered, a field that becomes required, a narrower type |
| Operations | One that is removed | One that is added |
| Outcomes | One that is removed, or one that is added, because a caller's switch over the outcomes covered every one | |
| Shared definitions | One that is removed or replaced by another, because the contract exports each one as a named type | One that is added |
| Metadata | A name whose schema promises less, as for an outcome | A name that is added or removed, because every name is optional to a caller |

## What is not a difference

These are not differences:

- annotations such as `description`, `title`, `deprecated` and `examples`
- the order anything is written in, including the branches of an `allOf`, `anyOf` or `oneOf`

A branch that only moved is matched with its old position. A branch that changed is compared with
what is left on the other side. `prefixItems` is different: it sets the type of the element at
each position, so its order is a difference.

A key only counts as an annotation where a schema would be. The following are read as names, even
if they are called `description` or `title`:

- a property name
- a pattern
- a name that a map such as `dependentSchemas` or `$defs` uses as the key for a schema
- a name listed by a keyword such as `dependentRequired`

A bound is read by its effect. A bound written at its default value (the value its keyword has
when it is left out) is the same as no bound, so it is not a difference. Removing `minContains: 0`
adds a bound instead of removing one. This is because an array with a `contains` and no
`minContains` must hold at least one match.

`const` and `enum` are read together when both appear, because each limits what the other admits.

## Open enumerations

An outcome may list the values it knows about next to a type it admits in full:
`anyOf: [{ "enum": [...] }, { "type": "string" }]`. Those known values can change freely, because
the outcome already admitted any string.

A new field may be declared with a name that a dictionary already covered, through
`additionalProperties` or a `patternProperties` entry. That field is compared with what the
dictionary said. So if an outcome's dictionary values were strings, the new field cannot quietly
become a number.

## Definitions and negation

A definition is compared on each side of the call where it is used: input, outcome or both. Codegen
finds where a definition is used by reading the schemas themselves, not by following the path the
comparison took. This means:

- If a composition changed too much to be matched, the definitions its branches name are still
  checked.
- A definition used as an input is checked by the input rules. A definition used as an outcome is
  checked by the outcome rules. Checking it as one never counts as checking it as the other.

Some definitions are compared as neither side. These are definitions reached under:

- a `not`
- an `if`
- a `contains` with a `maxContains`
- a branch of a `oneOf`

Under these, admitting more can mean the whole schema admits less, and the comparison cannot tell
which way a change lands. So any difference in such a definition is a break.

## What the comparison does not attempt

It is not possible in general to decide whether one JSON Schema admits everything another admits
(subsumption). The comparison does not try. Instead:

- the keywords above are read one at a time
- `allOf` and `anyOf` are read branch by branch
- a difference in any other keyword, or one that does not fit these rules, counts as a break

`oneOf` admits a value that exactly one branch admits. That is not how the call contract treats it,
and the comparison does not read it as a union. A change to one branch can have the opposite
effect on the whole:

- If a branch comes to admit more, it can match a value another branch already admitted. Two
  branches then match, so the `oneOf` refuses that value.
- If a branch is removed, a value that matched two branches may now match only one. The `oneOf`
  then admits it.

So every change to a `oneOf` both widens and narrows it. A `oneOf` only counts as unchanged if its
branches say the same as before and refer to the same things. Any definition a branch refers to is
frozen with it.

Anything the comparison cannot place counts as a break. Refusing a safe change only costs someone
a second look.
Accepting an unsafe change costs every caller.

:::caution[Not covered]
The check covers the schemas only. It does not compare the generated types when the generator
changes. It does not compare the error codes, which live in `@repo/gateway-types`. A change to
either needs the same rules applied by hand.
:::
