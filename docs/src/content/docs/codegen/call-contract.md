---
title: The call contract
description: The generated TypeScript types a caller compiles against.
---

`.gen/client/rpc.ts` describes what a caller sends and receives. It contains types only. Its one
import is a type import of `@repo/gateway-types` for the envelope shapes, which is removed when it
compiles. That package declares no dependencies of its own, so a consumer needs neither the
runtime nor the generator.

Each gateway will have its own [client library](/flex-platform/domains/overview/#calling-gateways),
built from this file. It wraps the contract and invokes the gateway, so a domain calls typed
operations instead of building envelopes. The client libraries are planned.

The operation's input shape comes from its JSON Schema. The driver decides how its fields reach
the upstream. For openapi-rest, see
[Input convention](/flex-platform/drivers/openapi-rest/overview/#input-convention).

Each response is either an error envelope or a success carrying one of the declared outcomes.
This lets callers check that their handling covers every outcome. In the example below, the
explicit return type makes a missing case a type error under the workspace's strict settings.
TypeScript does not require every switch statement to be exhaustive by default.

```ts
import type { GetIdentityExchangeResponse } from "@govuk-once/flex-gateway-udp/client";

export function serviceId(response: GetIdentityExchangeResponse): string {
  if (!response.ok) throw new Error(response.error.code);
  switch (response.outcome) {
    case "ok":
      return response.data.serviceId;
  }
}
```

## Exported names

| Name | What it is |
|---|---|
| One type per shared definition | Each key of the schemas' `defs`, under that name. |
| `<Operation>Input`, `<Operation>Result`, `<Operation>Response` | Per operation, in PascalCase: its input, the union of its outcomes, and its response. |
| `Operations` | Each operation name mapped to its input and result. |
| `OperationName`, `OperationInput`, `OperationResult`, `OperationResponse` | Generic names over `Operations`. |
| `GatewayRequest` | One call as the handler receives it: the operation, its input and the envelope's `secure` values. |
| `ResponseMeta` | What the gateway reports alongside a result: every declared name, each optional. |
| `ErrorResponse` | The failure envelope. |

A response is `ErrorResponse` or a success carrying one of the operation's outcomes. If the
gateway declares `meta`, both have `meta?: ResponseMeta`, and a name the gateway does not declare
is a type error. If a gateway reports nothing, its types have no `meta`.

## Comments

The contract turns what the schemas say about themselves into comments, which a caller's editor
shows. In front of each shared definition and each field, it writes:

- the schema's `description`, or its `title` if there is no description;
- `@deprecated`, if the schema sets `deprecated`.

A field that only refers to a definition takes the definition's comment. An outcome's comment
describes the data it carries. An operation's comment is the `description` its configuration
gives it.

This text does not come from the gateway itself. A schema derived from an upstream's document
carries the document's text, and that text is written into code a caller compiles. So every
comment is written the same way:

- `*/` cannot end it.
- Every `@` is written as the character reference `&#64;`, so no text can open a JSDoc tag,
  wherever it appears. Escaping with a backslash stops the compiler parsing a tag, but it does not
  stop `stripInternal` removing the declaration the tag marks.
- Each line of the text is a line of one block comment, on lines of its own.

Names and values are written into the contract as string literals or checked identifiers, never as
raw text. An editor that renders a comment shows the `@` again. The only tags in the contract are
ones the generator wrote: `@deprecated`, from a schema that declares itself deprecated.

## From schema to type

A schema often states one shape in several places: `properties` in one place, `required` in
another, more of both inside `allOf`, and the rest behind a `$ref`. TypeScript cannot say "this
keyword applies only when the value is an object". So the generator gathers the object keywords
from a composition into one declaration, and intersects everything else with it. A reference keeps
its name.

- `anyOf` and `oneOf` become unions. Each branch is read together with the schema around it. So a
  field the schema requires stays required in every branch, and a schema that also admits null
  still admits it.
- An array whose first elements are typed by `prefixItems` becomes a tuple. Elements that the
  schema's length does not require are optional.
- A field the schema requires but does not describe anywhere is typed as `unknown`. The field
  must be present, but its value has no declared type.
- Some compositions have more possible paths through their `anyOf` and `oneOf` branches than the
  generator will write out. These fail generation instead of being described loosely. Moving the
  branches into a shared definition stops the expansion, because a `$ref` is read as a name.
- A schema nested more than 100 levels deep fails generation. A reference does not add to the
  depth.

The generated types describe shapes, not every validation rule. Values can typecheck and still
fail runtime validation, for example a string that violates a schema's `pattern` or `maxLength`.

### Objects

An object's type has only the fields its schema declares, unless the schema says it holds more:

- `additionalProperties: true`, or a schema for the other fields, gives the type an index
  signature. Leaving `additionalProperties` out does not.
- `patternProperties` types the names its patterns match. When `additionalProperties` says what
  the other names carry, these types are added to the index signature.
- When `additionalProperties` is left out, the pattern-matched names are left out of the type too,
  like every other unlisted name.

The reason for the last rule is that an index signature is a promise about every name. A schema
that says nothing about the names its patterns miss cannot make that promise. For example,
`{ "unmatched": 123 }` passes a validator whose only pattern is `^x-`. A signature typed from that
pattern would have let a caller read `unmatched` as a string.

To a validator, leaving `additionalProperties` out admits every other name, just as `true` does.
This lets an outcome keep validating when an upstream adds a field. The type stays as declared, so
a contract never offers fields that depend on which version a caller has. Fields an upstream adds
still reach a caller, but they are not validated or declared.

On an input, the difference works the other way. The compiler rejects an object literal with an
extra field, even where the validator would accept it. It is still worth setting
`additionalProperties: false` on an input, because the validator is what decides. Without it, an
extra field passes validation, and then fails the request as `INTERNAL` because no `parameters`
entry maps it.

### Open enumerations

An outcome can list the values it knows of and still admit other values an upstream sends later.
It does this with a union of a type and values of that type:
`anyOf: [{ "enum": ["Valid", "Revoked"] }, { "type": "string" }]`.

The generator emits this as `"Valid" | "Revoked" | (string & {})`. If it were written with a bare
`string`, TypeScript would read the whole union as `string` and lose the values. With this type:

- a caller's editor still suggests the known values;
- an exhaustive switch over them, such as the one in the example above, needs a `default` branch;
- a value added later arrives in that `default` branch, so adding one
  [breaks no caller](/flex-platform/gateways/compatibility/#open-enumerations).

An `enum` on its own stays a closed union, which is what an input needs.

The generator recognises the same union however a schema writes it:

- the values and the type side by side;
- the type enclosing a union of the values;
- either of these behind a `$ref`, which is followed to the definition it points at.

When it follows a `$ref`, the generator looks at the types the definition declares, instead of the
`type` keyword it writes. A definition that also admits null, through `nullable` or a list of
types, is declared as a union with null. Its name cannot be marked open: that would remove the
null, and a caller could not assign values the validators accept.

The generator does not follow a definition that also admits null, or one that is itself a
reference or a composition. The editor then does not suggest the values, but nothing is typed
wrongly.

The compatibility check recognises the union in the same way when the type is written inside it.
When the type is behind a `$ref`, the check rejects an added value. This errs on the safe side.

:::caution
This type does not narrow to a single value by itself. After `if (status === "Valid")`, the type
is still `"Valid" | (string & {})`, because the open branch also admits that string. So a function
that takes `"Valid"` rejects the variable, even though the comparison has checked its value. Pass
the literal instead of the variable.

A caller compiled against a plain `string` can stop compiling for this reason when it is given one
of these types, even though the schemas have not changed.
:::
