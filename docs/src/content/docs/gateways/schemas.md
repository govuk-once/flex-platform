---
title: Schemas and versions
description: How a gateway's schemas are stored, versioned and kept up to date with its upstream.
---

A gateway's schemas are stored next to its configuration as JSON, one file for each version:

```txt
schemas/
  0001.json
  0002.json
```

Codegen generates from the highest-numbered version. A merged version is never changed or
removed. To change the contract, add the next version.

Every version is written by
[`gateway-schemas`](/flex-platform/gateways/schemas/#bringing-a-gateways-schemas-up-to-date), never
by hand. The gateway's driver derives it: from the upstream's own description where there is one,
and from schemas the configuration declares where there is not.

Each version is [checked against every version before it](/flex-platform/gateways/compatibility/),
using the files as they are now. If someone rewrote a version in place, the check would hold the
others to something different. So CI refuses a pull request that changes or removes a merged
version.

There is one escape hatch, and it is not meant to be used often. A merged version that was never
deployed, such as a placeholder, can be replaced once someone who can label the pull request adds
`schema-history-override`. Never use it for a version a caller may already depend on: changing that
version is exactly the break this check exists to stop. With or without the label, CI comments on
the pull request with the merged versions it changes, so the exception is seen in review.

Version names are four digits, numbered from `0001` with no gaps, so they sort in the order they
were written. Generation fails if the directory holds anything else or the numbering has a gap. It
does not skip over the problem.

## The shape of a version

A version holds:

- the shared definitions
- what the gateway reports alongside a result
- for each operation, an input schema and a schema for each outcome

```json
{
  "defs": { "UserRecord": { "type": "object" } },
  "meta": { "upstreamRequestId": { "type": "string", "maxLength": 128 } },
  "operations": {
    "createUser": {
      "input": { "type": "object" },
      "outcomes": { "created": { "$ref": "UserRecord" } }
    }
  }
}
```

| Field | Holds |
|---|---|
| `defs` | Shared definitions, referenced from any schema as `{ "$ref": "Name" }`. The call contract exports each one as a named type. |
| `meta` | Optional. The names a gateway [reports alongside a result](/flex-platform/gateways/responses/#response-metadata). Each is the schema of one scalar. |
| `operations` | For each configured operation, `input`, and `outcomes` keyed by outcome name. Every operation declares at least one outcome. |

A `$ref` names a key of `defs`. A pointer into the schema itself, such as `#/$defs/Body`, compiles
to a validator. But it has no name the call contract can use, so generation fails. Declare the
subschema in `defs` and reference it by that key instead.

## A version is data

A version is parsed, never imported. Reading it runs no code, and an earlier version can still be
read however much the configuration has changed since. Nothing typechecks a JSON file, so codegen
checks a version's shape when it reads it. It reports every problem in one run.

Codegen refuses:

- **An unknown field.** Otherwise a misspelt field would be ignored.
- **The name `__proto__`**, as a definition, an operation or an outcome, and anywhere inside a
  schema. In JSON it is an ordinary key, but in a JavaScript object literal it is not. If it got
  through, Ajv would:
  - skip a property with that name instead of compiling it
  - read a required property with that name from the prototype
  - write the schema back out as an object literal, which the key would change the shape of
- **A character that does not display**, anywhere in a version, in a name or a value. This means
  control characters, and the format characters that reorder or hide the text around them. A
  person reviews each version, and its text is written into generated code. One of these
  characters could make a version show a reviewer one thing and hold another. Codegen reads the
  parsed value, so it also finds a character written as a `\u` escape.

Ajv checks that each schema is a valid JSON Schema when the validators are built.

## Bringing a gateway's schemas up to date

`gateway-schemas` runs in a gateway package, in the same way as `gateway-codegen`. `pnpm schemas`
runs it for every gateway, and carries on if one fails.

A person runs it, reads its output and commits what it wrote. It uses the network, so CI never
runs it. In CI, codegen compares the committed versions with each other. Where a driver can derive
without the network, codegen also checks that the latest version is still what it derives. See
[What codegen checks](/flex-platform/codegen/checks/#what-the-driver-derives).

```bash
pnpm --filter @govuk-once/flex-gateway-udp schemas
```

The command asks the gateway's driver to derive schemas, from the upstream's own description or
from schemas the configuration declares. For openapi-rest, the description is the OpenAPI document
its `spec` names. See [Deriving schemas](/flex-platform/drivers/openapi-rest/deriving-schemas/).

The derived schemas must pass every check a version on disk must pass:

- its shape
- each schema compiling the way the validators compile it
- agreement with the configuration

The command then compares them with every existing version, as codegen will once they are
written. What changed is read against the latest version:

| Upstream | What the command does |
|---|---|
| Its shape matches the latest version | Writes nothing. A reworded `description` is not a change of shape, so the contract's comments can fall behind the upstream's until its shape next changes. |
| Its shape changed and no caller breaks | Writes the next version, in the order it was derived, and lists the changes. |
| A change would break a caller | Writes nothing, reports every break prominently, and fails. The gateway is still generated from the latest version. |
| The gateway has no versions | Writes `0001.json`. |

A version is written as JSON indented with two spaces, in the order its source was written. The
contract therefore lists an object's fields in the order the upstream documents them. No formatter
decides the layout, so the same schemas always produce the same bytes, whatever tools are
installed.

The file is only created if it does not already exist. An existing version is never overwritten.
If two runs try to write the same version at once, only one succeeds.

The command's output includes an upstream's own text: field names from the comparison, and notes
from the driver's derivation. Any character that does not display is printed as its code point.
This stops upstream text from moving the terminal's cursor back over the report above it. The
error that stops a run is printed the same way.
