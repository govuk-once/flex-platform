---
title: openapi-rest
description: "The HTTP driver: its package layout and how an operation's input becomes a request."
sidebar:
  label: Overview
---

`@repo/gateway-driver-openapi-rest` is the only package that knows HTTP. Methods, paths, status
codes and headers live here. The runtime and codegen see only an opaque driver definition and an
execution function. The driver describes an upstream in the terms its OpenAPI document uses, and
derives the gateway's schemas from that document.

## Package layout

The package is split by when its code runs.

| Directory | Holds | Runs |
|---|---|---|
| `src/config/` | The driver and authentication definitions, `defineHandler`, and the build-time check of an operation against its schemas. | When codegen loads a configuration. Nothing in it reaches the network or a secret. |
| `src/runtime/` | The executor and everything under it. | When the gateway starts, through the definition's `createExecutor`, which imports it on first call. |
| `src/derive/` | Schema derivation from the OpenAPI document, using `@scalar/openapi-parser`. | In `gateway-schemas`, and in codegen with the network refused, through `deriveSchemasModule`. Never bundled. |
| `src/*.ts` | Code both sides use: the client and handler types, the upstream template parser, header rules and path parameter encoding. | Either. |

A lint rule stops `config/` and the shared modules from importing `runtime/` statically. It also
stops anything except tests from importing `derive/`.

## Input convention

A caller sends one flat `input` object. The caller does not know which fields become path
parameters, query parameters or headers. The operation declares that for each input field, using
the OpenAPI document's terms. The request body, if there is one, goes in the top-level `payload`
field.

| Operation field | Purpose |
|---|---|
| `upstream` | `"<METHOD> /path/{param}"`. Methods: GET, POST, PUT, PATCH, DELETE. |
| `parameters` | Maps an input field to `{ in, name? }`. `in` is `path`, `query` or `header`. `name` is the upstream parameter or header, when it differs from the field. Every `{param}` in the template needs an entry with `in: "path"`. |
| `matches` | The document's template that serves this path, when the document does not declare the path itself. Only read when deriving. See [Deriving schemas](/flex-platform/drivers/openapi-rest/deriving-schemas/#paths-the-document-does-not-declare). |
| `narrow` | The shape of a body or outcome that the document leaves open. Only read when deriving. |

```ts
updateUser: {
  upstream: "PATCH /v1/orgs/{orgId}/users/{id}",
  parameters: {
    orgId: { in: "path" },
    userId: { in: "path", name: "id" },
    dryRun: { in: "query" },
    etag: { in: "header", name: "if-match" },
  },
}
// input { orgId: "acme", userId: "u1", dryRun: true, etag: "abc", payload: { name: "Ann" } }
// sends PATCH /v1/orgs/acme/users/u1?dryRun=true with If-Match: abc and body {"name":"Ann"}
```

`parameters` must match the operation's input schema:

- every schema field appears in `parameters` or is `payload`;
- every template parameter appears in `parameters` with `in: "path"`.

A template parameter with no entry, or a path entry that names a parameter the template lacks,
fails in three places: as a type error at `defineGateway`, when the executor is created, and
during generation. The type error shows the corrected `parameters` shape. That is either a
missing entry keyed by the parameter, or an entry whose `name` must be one of the template's.

Codegen also sees the schemas, so it reports more. See
[What codegen checks](/flex-platform/drivers/openapi-rest/overview/#what-codegen-checks).

### How values are sent

When a request is built from the mapping, every input field must be mapped or be `payload`. An
unmapped field is a configuration error, and the request fails as `INTERNAL`. The diagnostic
gives the number of unmapped fields but never their names. This is because a schema that allows
additional properties lets the caller choose the names.

- **Path** values must be scalars. Each is percent-encoded as one segment. A value is rejected if
  it is only dots, or if it contains `/`, `\`, `?`, `#`, `%` or a control character. The URL
  parser would collapse `..`, and an upstream that decodes before it routes would reinterpret the
  rest. For example, `../../admin` would reach `/admin` with the gateway's credentials. Constrain
  path parameter formats in the input schema so that callers get `INVALID_INPUT`. Do not rely on
  this check.
- **Query** values may be scalars or arrays of scalars. An array repeats the key. A space is
  written `%20` and a plus `%2B`, so no upstream reads one as the other.
- **Null and undefined** query and header values are left out.
- **Bodies** are JSON with `Content-Type: application/json`. A `payload` on a GET is an error.
- Every request sends `Accept: application/json`.

### Configuration errors

These fail when the executor is created:

- an unsupported method;
- a template parameter without an entry;
- an entry naming a path parameter the template does not declare;
- two fields feeding one upstream name;
- a reserved header (`content-type`, `content-length`, `host`, `transfer-encoding`,
  `connection`);
- a mapping onto a header the authentication owns;
- a handler that is not a function.

A misspelled key inside a parameter mapping is a type error at `defineGateway`.

## What codegen checks

Codegen passes the configuration and the schemas to the driver's
[`checkSchemas`](/flex-platform/drivers/contract/#checkschemas), and fails when:

- a `{param}` in the template has no `parameters` entry with `in: "path"` naming it, or an entry
  names a parameter the template does not declare;
- a mapped field, for a path, query or header parameter, is not a field of the input schema;
- an input field is neither mapped nor `payload`, so nothing would carry it upstream;
- a path parameter's input field is not required by the schema, which would leave a segment of
  the path with no value;
- two fields supply the same path parameter, query parameter or header, so only one would be sent;
- the input schema declares `payload` for a method that cannot carry a body, or a mapping names a
  header the gateway's authentication owns;
- the schemas' `meta` and the driver's `metadata` disagree. See
  [Agreement with the schemas](/flex-platform/drivers/openapi-rest/metadata/#agreement-with-the-schemas).

An operation with a custom handler builds its own request, so some of these are left to the
handler. See
[What codegen checks for a handler](/flex-platform/drivers/openapi-rest/handlers/#what-codegen-checks-for-a-handler).

## The upstream must use https

The target, from `UPSTREAM_TARGET` or the secret field `target` names, is an absolute base URL.
An http target is accepted only for a loopback host. A local stub, or a sidecar that terminates
TLS, still works. A remote address cannot be configured without TLS. The same rule applies to
every request an authentication part makes.
