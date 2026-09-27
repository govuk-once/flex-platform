---
title: What codegen checks
description: The checks that reject a gateway before anything is generated.
---

Codegen fails a gateway, and writes nothing, when its configuration and schemas disagree. It
reports every problem it finds in one run. Without these checks, each problem would instead fail
when the executor is created, or cause an `INTERNAL` failure on a request in production.

## Generic checks

- The driver must give `deriveSchemasModule` as a `file:` URL, because every gateway's schemas are
  derived. This check reads only the URL. The module is loaded later, to check
  [what the driver derives](/flex-platform/codegen/checks/#what-the-driver-derives).
- Each operation must have schemas, and each set of schemas must have an operation.
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
synchronously.

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
