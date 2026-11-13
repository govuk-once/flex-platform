---
title: What codegen checks
description: The checks that reject a gateway, in the order codegen runs them, and what fails while it writes.
---

Codegen fails a gateway when its configuration and schemas disagree. Without these checks, each
problem would instead fail when the executor is created, or cause an `INTERNAL` failure on a
request in production.

It checks in stages, in this order, and stops at the first stage that finds a problem, reporting
what that stage found. So fixing one stage's problems can uncover the next stage's.

1. The schema versions are read, by the rules in
   [Schemas and versions](/flex-platform/gateways/schemas/).
2. The latest schemas are compiled. See [Generic checks](#generic-checks).
3. Each version is compared with every one before it, by the
   [compatibility rules](/flex-platform/gateways/compatibility/).
4. The configuration is checked against the latest schemas: the generic checks, then the
   [driver's](#driver-checks).
5. The latest version is compared with [what the driver derives](#what-the-driver-derives).

Only once every stage has passed is `.gen/` deleted and written again. A failure while writing,
such as [two types that need one name](#while-writing), fails the command and leaves an incomplete
`.gen/`, which the next run replaces.

## Generic checks

- The gateway's `id` must be 1 to 32 lowercase letters, digits and hyphens, starting with a letter
  and not ending with a hyphen, as `assertGatewayId` in `@repo/gateway-core` checks. The id names
  the gateway's function and its client package, and generated code is written from it.
- No operation may be named `then`. A client with a `then` function would be taken for a promise,
  and returning it from an async function would call that operation.
- The driver must give `deriveSchemasModule` as a `file:` URL, because every gateway's schemas are
  derived. This check reads only the URL. The module is loaded later, to check
  [what the driver derives](/flex-platform/codegen/checks/#what-the-driver-derives).
- The configuration must declare at least one operation.
- Each operation must have schemas, and each set of schemas must have an operation.
- Every name in the schemas, of a shared definition, an operation, an outcome or a `meta` entry,
  must be a JavaScript identifier, `[A-Za-z_$][A-Za-z0-9_$]*`, because each names an export of
  the validators.
- Every operation must declare at least one outcome.
- Every name in the schemas' `meta` must declare one scalar type: string, number, integer or boolean.
- Every schema compiles in Ajv's strict mode.

After the configuration and schema versions are loaded, the latest schemas are compiled before
compatibility and driver checks. An invalid schema is therefore reported as an invalid schema,
and not through the errors those later checks would produce from it.

Strict mode makes a misspelt keyword, or a constraint that applies to nothing, fail generation
instead of passing silently. One strict check is turned off. It requires a tuple's length to be
fixed, which would reject an array that types its first elements by position and the rest with
`items`.

A schema with asynchronous validation is always rejected, because the dispatcher validates
synchronously. It counts only `true` as a pass, so a validator that answered with a promise
would have every value refused.

## While writing

The [call contract](/flex-platform/codegen/call-contract/) gives each shared definition a type of
its own name, and each operation the types `<Operation>Input`, `<Operation>Result` and
`<Operation>Response`. Two that need the same name fail the run, and so does a definition named
like a type the contract or TypeScript declares, such as `OperationResult` or `Record`. Rename one
of them. A schema the contract cannot describe, such as one nested too deeply, fails the run too.

## Driver checks

The driver checks whether an operation's fields and its schemas describe the same request,
through [`checkSchemas`](/flex-platform/drivers/contract/#checkschemas) on its definition. The
generator itself names no method, path, query parameter or header. Each driver documents its own
checks. For openapi-rest, see
[What codegen checks](/flex-platform/drivers/openapi-rest/overview/#what-codegen-checks).

## What the driver derives

Codegen generates from the committed version, not from what it was derived from. So it also runs
the driver's derivation, with the network refused, and compares the result with the latest
version. It fails if `pnpm schemas` would write a new version: for a gateway whose configuration
declares its schemas, that means they changed and `pnpm schemas` has not been run since.

It compares them the way `pnpm schemas` does, using the
[compatibility rules](/flex-platform/gateways/compatibility/). A reworded `description` or a
change of order writes no version, so it fails nothing here either.

A driver whose derivation has to fetch its upstream's description, as openapi-rest does from an
https `spec`, cannot be derived without the network, so this check is skipped for it. Its
versions change only when someone runs `pnpm schemas`, and the comparison of its versions holds
them.
