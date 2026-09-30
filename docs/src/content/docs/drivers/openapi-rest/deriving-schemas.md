---
title: Deriving schemas
description: How openapi-rest turns an OpenAPI document into a gateway's schemas.
---

The driver derives a gateway's schemas from the OpenAPI document that its `spec` names. This
happens when someone runs
[`gateway-schemas`](/flex-platform/gateways/schemas/#bringing-a-gateways-schemas-up-to-date).
`spec` is an https URL (ideally pinned to a release) or a path within the gateway's directory. The
document itself is never committed. Only what is derived from it is committed.

`@scalar/openapi-parser` parses the JSON or YAML and checks the document. It also rewrites
OpenAPI 3.0's dialect as 3.1's, which is JSON Schema 2020-12. The code that does this is in
`src/derive/`. The definition gives it as the `deriveSchemasModule` URL, and nothing a gateway
imports reaches it. So the parser is never part of a deployed gateway.

Only the operations the configuration declares are derived. Each one is found by its `upstream`
method and path. An `operationId` is not used. A document does not have to include
one, and when it does, it may not be usable as a name.

## What becomes what

| From the document | In the gateway's schemas |
|---|---|
| A parameter the operation's `parameters` map | An input field, under the name the configuration gives it, with the parameter's schema. If the schema has no description, the parameter's description is used. Header names are matched case-insensitively. |
| A required parameter nothing maps | The run fails. An optional one is left out, with a note. A cookie is never sent: a required cookie fails the run, and an optional one gets a note. |
| A parameter the driver could not send as written | The run fails. See [below](#parameters-the-driver-cannot-send). |
| A request body | `payload`, always required, because a body an operation declares is one its upstream expects. Only `application/json`, because that is all the driver sends. A response is parsed as JSON regardless of its content type, so any type in the `+json` family works for a response. |
| 200, 201, 202, 204 | The outcome the driver [maps that status to](/flex-platform/drivers/openapi-rest/outcomes/). A 204, or a success with no body, is `null`. |
| 4xx, 5xx, `default` | Nothing. These reach a caller as error codes. |
| `#/components/schemas/Name` | The shared definition `Name`. Only definitions that an input or an outcome reaches are kept, in the order the document declares them. Parameters, request bodies and responses written as references are resolved. |
| `security` | Nothing. How a gateway authenticates is set in its configuration. |

## Inputs and outcomes are converted differently

The two sides of a call fail in different ways:

- an input can be loosened later, but never tightened;
- an upstream adds fields, values and length to what it sends without asking.

If an outcome were made stricter, a minor upstream release would cause failed responses in
production. If an input were made looser, that could not be undone.

| | Input: what a caller sends | Outcome: what an upstream sends |
|---|---|---|
| An object that says nothing of other fields | Closed, so a field can be allowed later and never has to be disallowed. An object inside `allOf`, `anyOf` or `oneOf` is left open, with a note, because closing one part would refuse the fields the other parts declare. An object that names no field at all is an object of any shape. It is left open, with a note, and the contract types it as `Record<string, unknown>` until an operation's `narrow` states its shape. | Left open. An object the document closes is opened, so an upstream that adds a field does not fail its responses. Any field it adds reaches a caller undeclared. |
| `enum` | Kept exactly. | Becomes the known values alongside the type that admits the rest: `anyOf: [{ "enum": [...] }, { "type": "string" }]`. A value the upstream adds then breaks no caller. A single listed value on a field of a union's branch stays as it is, because it tells the branches apart. `const` is never opened. |
| Bounds, `pattern`, `format` | Kept exactly. | Dropped. An outcome is held only to its shape: the types, the fields and which fields are required. `minContains: 0` is kept, with the `maxContains` a validator needs beside it. Without `minContains: 0`, `minContains` defaults to one, so dropping it would add a bound. |
| A definition both sides use | Gets its own name, `NameInput`, where the two sides treat it differently. So does anything in an input that refers to it. Renaming only changes places that hold a schema. A `const`, `enum`, `default` or `examples` that holds an object keeps every key it was written with, including one called `$ref`, because that is a value the caller sends and not a reference. | Keeps the document's name. |

A definition is converted once and used for every place it is named. So it is converted for the
strictest of those places:

- a definition named inside a composition anywhere is left open everywhere;
- a definition named as a branch of a union keeps what tells it apart from the other branches.

So at the same place in a schema, a schema written out in full and the same schema written as a
named definition admit the same values.

### Where the direction turns around

Each conversion above moves what a schema admits in one direction, on purpose. In some places
that direction is reversed:

- under a `not`;
- under an `if`;
- under a `contains` that a `maxContains` counts;
- under a `oneOf` whose branches nothing tells apart.

In these places the upstream's schema is kept exactly as written, with a note. If such a schema
declares no type but uses keywords that need one, the run fails. Neither keeping it nor adding
the type would be safe.

The branches of a `oneOf` can be told apart when:

- every branch is an object that requires a field fixed to a scalar value of its own;
- no two branches fix that field to the same value.

That field keeps telling the branches apart, even when other parts are opened. A tag that a branch may
leave out does not count as a tag. Nor does a tag fixed to an object.

The elements of a `prefixItems` tuple are schemas in their own right. An ordinary object among
them is closed like any other input object.

### On either side

Anything JSON Schema has no keyword for is left out: `example`, `xml`, `externalDocs`,
`discriminator` and `x-` extensions.

`nullable` is read literally. Only `nullable: true` adds null, and it adds nothing if there is no
type beside it.

An upstream's tools accept some schemas that the validators' strict mode refuses. Two fixes
handle these:

- a schema that uses the keywords of one type but declares no type is given that type;
- a keyword that does not apply to the declared type is dropped.

Each fix is noted in what the command prints, for whoever reviews the result. Anything that
cannot be derived at all is reported together, and the run fails.

## Parameters the driver cannot send

The driver writes a path parameter or a header as one scalar. It writes a query parameter as a
scalar or a repeated name. The run fails for a parameter it could not send as written:

- an object anywhere, or an array in a path or a header;
- an array whose elements are not scalars, or whose tail nothing describes;
- an array that a query does not repeat (`explode: false`), a `style` other than the one the
  driver writes, or `allowReserved`;
- a required parameter that admits null (null is how a caller leaves a parameter out, so a path
  parameter, which is always required, may never admit it);
- a required query array that admits an empty array, because an empty array also leaves the
  parameter out (state that it holds something, with `minItems` or a `contains`);
- a schema that admits a value of any type, or one that refers to itself;
- a parameter described by its `content` instead of a schema.

The check reads what a parameter admits from the converted schema, which is what the validators
are generated from. It also reads the definitions that schema names, once those are converted
too. Reading the document again would give a different answer for the same parameter, because by
then any keyword that does not apply to the declared type has been dropped. For a required query
array, the check reads `minItems` or `contains` in the same way it reads the types: through the
definitions a schema names and the branches it is written in.

A part that constrains nothing, written as `true` or `{}`, admits every value and is treated that
way. So a union that holds one is refused. It is not read as the narrower schema beside it.

Array elements are read the same way. An array whose elements nothing describes admits every
element. So, beside a branch that admits strings:

- a union admits every element;
- an `allOf` admits strings.

If `items` is left out, nothing describes the elements after the ones `prefixItems` names.

## Paths the document does not declare

A document may serve paths it does not declare, through a template that takes all the remaining
segments. An example is `/v1/{resourcePath+}` for a store that keeps whatever it is given under
any path. An operation never takes such a parameter from a caller. That would let one operation
reach any other operation's endpoint, bypassing its schemas and its bindings. Instead, the
operation writes its path in full and says which template serves it:

```ts
getNotificationPreferences: {
  upstream: "GET /v1/notifications",
  matches: "/v1/{resourcePath+}",
  narrow: { outcomes: { ok: { type: "object", properties: { data: NOTIFICATION_PREFERENCES } } } },
},
```

`matches` must be stated. It is never inferred. Deriving fails for a path the document lacks,
unless the operation names the template that serves it. The error lists the templates that
could. Deriving then checks that:

- the template exists;
- the path fits it, with `{name}` taking one segment and `{name+}` one or more, all written out;
- no more specific template fits, because that is the one the upstream would route to;
- a router could not read the path as another path. So there is no empty segment (as a trailing
  or doubled slash produces), and no slash or backslash written inside a segment (as `%2F`, `%5C`
  or `\`).

For example, `GET /v1/sar/abc/` fits `/v1/{resourcePath+}` as written. But a router that ignores
the trailing slash would send it to `/v1/sar/{sarId}`, so it is refused. `matches` on a path the
document does declare is also refused.

A path with its own parameters is checked the same way. For example, `GET /v1/app/{id}` reaches
`/v1/app/admin` if the document declares that path. Deriving refuses it unless the parameter's
schema refuses every value a request would write as that text, through a list of values, a type
or a pattern. So `/users/{id}` beside `/users/me` derives if `id` is an integer, and is refused if
`id` is any text. If the check cannot apply the schema (for example, it uses a `format` that
nothing implements), the schema does not rule anything out, and the path is refused.

When deriving checks whether a path could reach another endpoint, it decodes the text before
comparing it. A template writes its segments as they go into a URL. So `é` and `%C3%A9` are the
same segment, and a value of `admin panel` reaches `/v1/admin%20panel`. When deriving fits a path
to the template it names, it compares the text exactly as written. This can only refuse more
paths.

A parameter is wherever a request puts one. This is how the runtime reads it too. So `{id}.json`
is a parameter followed by text. It reaches `/v1/admin.json` but not `/v1/notifications`. Fitting
a path through a segment like this is refused, because the path would fill part of the segment and
keep the rest, and the check does not handle that.

The part of the template that the path fills needs no input field, because no caller supplies
it. The validators themselves check the text the path writes against the document's schema for
that parameter. They use the same dialect and formats that a gateway's validators are generated
with.

A segment is text, but it may stand for a number or a flag. Every reading of it is tried. So
`/things/42` fills a parameter of integers, and `/things/a%20b` fills one whose values include
`a b`. A fixed identifier is written out and checked against its `format`.

A segment is only read as a number if the text is how that number is written, because that is
how a request writes a value. `9007199254740993` is not read as a number: it parses to the number
written `9007199254740992`. Nor are `007`, `42.0` or four hundred digits.

A parameter the document describes by its content instead of a schema is refused, as it is when a
caller supplies it. If a schema says something the check cannot apply, the value is refused. It
is not admitted on the strength of the rest of the schema, because the upstream will still hold
it to the part the check left out. A schema that would be checked asynchronously is refused, and
not run.

This is the only check the text gets. The parameter is no longer part of the input, so neither
generation nor a request's validator ever sees it.

An ordinary parameter can be filled the same way. For example, `GET /v1/identity/app/{id}` can
be matched against `/v1/identity/{serviceName}/{identifier}`. A parameter the path keeps goes by
the path's name for it. Either way, the request is sent to the path in `upstream`. Only deriving
reads `matches`.

## Narrowing what the document leaves open

A document may say only that a body, or a field in one, is an object of any shape. The body of
such a template usually does. Left like that, it stays open, and a caller's contract types it as
`Record<string, unknown>`. `narrow` states the shape the gateway's own services keep there:
`payload` for the request body, and `outcomes` by name.

- Where the document admits an object of any shape, or any value, the stated shape replaces it,
  at any depth. The stated shape must admit objects and nothing else. One that also admitted
  null would admit something the document did not.
- Where the document describes an object, what is stated about a field is set into it. The
  narrowing may make a field required or close the object. A field the document's object has no
  room for is refused. So is every field of an object the document closes with no fields. A field
  the document held through `additionalProperties`, as a dictionary does, keeps that schema too,
  because declaring a field exempts it from `additionalProperties`.
- Anything else is set beside what the document says, in an `allOf` that holds both.

So a narrowing only ever makes a schema admit less.

What a narrowing says about the thing it narrows, such as its description, is used in place of
what the document says. A narrowed body is used as written, so it is exactly as strict as it is
written. A narrowed outcome is held only to its shape, like any other outcome. It is open to
fields and values it does not list, and has no bounds. This is so that what one of the gateway's
own services comes to store there does not fail another service's read of it.

A narrowing is read in full before any of it is set into a schema. The reading checks:

- its shape, so a keyword written with the wrong kind of value is refused, and not silently
  filtered out and lost;
- the names it may not use;
- any `$ref` or `$dynamicRef`, which has nothing to refer to.

Schemas inside a narrowing are found by the same walk used everywhere else. So a `$ref` inside
an `allOf` is found as reliably as one at the top. A field may be called `$ref` or `properties`
and is still treated as a field. `true` and `false` are treated as the schemas they are.
