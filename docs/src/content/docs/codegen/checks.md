---
title: What codegen checks
description: The checks that reject a gateway, in the order codegen runs them, and what fails while it writes.
---

Codegen fails a gateway if its configuration and schemas disagree. Without these checks, each
problem would instead fail when the executor is created. Or it would cause an `INTERNAL` failure on
a request in production.

Codegen checks in stages, in this order. It stops at the first stage that finds a problem, and
reports what that stage found. So fixing one stage's problems can uncover the next stage's.

1. It reads the schema versions, by the rules in
   [Schemas and versions](/flex-platform/gateways/schemas/).
2. It compiles the latest schemas. See [Generic checks](#generic-checks).
3. It compares each version with every one before it, by the
   [compatibility rules](/flex-platform/gateways/compatibility/).
4. It checks the configuration against the latest schemas: the generic checks, then the
   [driver's](#driver-checks).
5. It compares the latest version with [what the driver derives](#what-the-driver-derives).

Codegen deletes `.gen/` and writes it again only once every stage has passed. A failure while
writing, such as [two types that need one name](#while-writing), fails the command. It leaves an
incomplete `.gen/`, which the next run replaces.

## Generic checks

- The gateway's `id` must be 1 to 32 lowercase letters, digits and hyphens. It must start with a
  letter and not end with a hyphen. `assertGatewayId` in `@repo/gateway-core` checks this. The id
  names the gateway's function and its client package, and codegen writes generated code from it.
- No operation may be named `then`. JavaScript would take a client with a `then` function for a
  promise. Returning the client from an async function would then call that operation.
- The driver must give `deriveSchemasModule` as a `file:` URL, because every gateway's schemas are
  derived. This check reads only the URL. Codegen loads the module later, to check
  [what the driver derives](/flex-platform/codegen/checks/#what-the-driver-derives).
- The configuration must declare at least one operation.
- Each operation must have schemas, and each set of schemas must have an operation.
- Every name in the schemas, of a shared definition, an operation, an outcome or a `meta` entry,
  must be a JavaScript identifier, `[A-Za-z_$][A-Za-z0-9_$]*`, because each names an export of
  the validators.
- Every operation must declare at least one outcome.
- Every name in the schemas' `meta` must declare one scalar type: string, number, integer or boolean.
- Every schema compiles in Ajv's strict mode.

Codegen compiles the latest schemas before the compatibility and driver checks. So it reports an
invalid schema as an invalid schema, not through the errors those later checks would produce from
it.

Strict mode makes a misspelt keyword, or a constraint that applies to nothing, fail generation
instead of passing silently. One strict check is turned off. It requires a tuple's length to be
fixed. That would reject an array that types its first elements by position and the rest with
`items`.

Codegen always rejects a schema with asynchronous validation, because the dispatcher validates
synchronously. The dispatcher counts only `true` as a pass. So it would refuse every value given
to a validator that answered with a promise.

## While writing

The [call contract](/flex-platform/codegen/call-contract/) gives each shared definition a type of
its own name. It gives each operation the types `<Operation>Input`, `<Operation>Result` and
`<Operation>Response`. The run fails if:

- two of these need the same name
- a definition has the name of a type the contract or TypeScript declares, such as
  `OperationResult` or `Record`
- the contract cannot describe a schema, such as one nested too deeply

For a clash of names, rename one of them.

## Driver checks

The driver checks that an operation's fields and its schemas describe the same request,
through [`checkSchemas`](/flex-platform/drivers/contract/#checkschemas) on its definition. The
generator itself names no method, path, query parameter or header. Each driver documents its own
checks. For openapi-rest, see
[What codegen checks](/flex-platform/drivers/openapi-rest/overview/#what-codegen-checks).

## What the driver derives

Codegen generates from the committed version, not from what it was derived from. So it also runs
the driver's derivation, with the network refused, and compares the result with the latest
version. It fails if `pnpm schemas` would write a new version. For a gateway whose configuration
declares its schemas, that means they changed and nobody has run `pnpm schemas` since.

Codegen compares them the way `pnpm schemas` does, using the
[compatibility rules](/flex-platform/gateways/compatibility/). A reworded `description` or a
change of order writes no version, so it fails nothing here either.

Some drivers have to fetch the upstream's description to derive, as openapi-rest does from an
https `spec`. Their derivation cannot run without the network, so codegen skips this check for
them. Their versions change only when someone runs `pnpm schemas`, and the comparison of versions
holds them.
