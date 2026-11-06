---
title: Driver settings and startup
description: The openapiRest settings, the executor options, header layering and what is checked at startup.
---

You configure behaviour on the driver definition, so it is reviewed along with the gateway.
Deployment values (the target and the secret) arrive as executor options.

## Driver settings

| Field | Purpose |
|---|---|
| `spec` | Where the OpenAPI document is. This is an https URL, ideally pinned to a release or commit, or a path within the gateway's directory. `gateway-schemas` reads it. Codegen reads it only when it is a path, to check [what the driver derives](/flex-platform/codegen/checks/#what-the-driver-derives), and never fetches a URL. Nothing reads it at runtime. |
| `auth` | Required. How requests are authenticated, as a list of parts (`[]` for none), and the secret fields each part reads. See [Authentication](/flex-platform/drivers/openapi-rest/authentication/). |
| `target` | A secret field that holds the upstream's address, such as `fromSecret("apiUrl")`, for an upstream whose secret includes it. It is used instead of `FLEX_UPSTREAM_TARGET` when both are set, and follows the same rules. If neither is set, the executor refuses to start. It is read when the executor is created. |
| `headers` | Static headers sent on every request, such as an API version. |
| `metadata` | What the gateway reports beside a result, read from response headers. See [Response metadata](/flex-platform/drivers/openapi-rest/metadata/). |
| `maxResponseBytes` | The largest response body to buffer. Defaults to 1 MiB. |

## Executor options

Nothing here is called by hand. Nothing the entry point calls is specific to this driver. The
[generated entry point](/flex-platform/codegen/entry-point/) reaches the driver as `config.driver`
and awaits `createExecutor` with the neutral `ExecutorOptions`.

| Option | For this driver |
|---|---|
| `target` | `FLEX_UPSTREAM_TARGET`, when it is set. It must be an absolute https base URL with no query, fragment or credentials. http is accepted only for a loopback host. A path prefix is kept. |
| `secret` | A provider for the secret that `FLEX_UPSTREAM_SECRET_ARN` names. The driver reads only the fields its `target` and `auth` name. |
| `log` | Where the driver logs while the executor is created. |

## Startup

Creation is asynchronous. If its configuration or initial secret checks fail, the gateway does
not start. Later secret reads, authentication exchanges and upstream calls can still fail during
a request.

1. **Configuration is checked.** Any of these fails before anything is retrieved:
   - an `auth` part that is not a definition, a reserved or invalid name in a part's header list,
     or a header two parts own;
   - a static header with an invalid name or value, one the driver sets, or one the
     authentication owns;
   - `metadata` the driver cannot read, or a `target` that is not a `fromSecret` field;
   - a `maxResponseBytes` that is not a positive integer;
   - `FLEX_UPSTREAM_TARGET`, when it is set, that is not an absolute https URL, or http to a
     loopback host, or that holds a query, a fragment or credentials. It is checked even when a
     `target` field will replace it;
   - having neither `FLEX_UPSTREAM_TARGET` nor a `target` field.

   Every operation is compiled, and fails on the
   [configuration errors](/flex-platform/drivers/openapi-rest/overview/#configuration-errors).
2. **The secret is retrieved and validated.** Creation fails on a secret that is missing,
   unreadable or not a JSON object, or a field the configuration names that is missing, if it is
   required, or is not a non-empty string without control characters or surrounding spaces. An
   optional field that is absent is logged by name. A `target` field's address is read here, and
   follows the same rules as `FLEX_UPSTREAM_TARGET`. If the field is optional and absent, and
   `FLEX_UPSTREAM_TARGET` is not set, creation fails here.
3. **Authentication state is built** on it, one instance per part. Each part's `create` must
   return an instance with a `headers` function.

A diagnostic about the secret names the field and the rule it broke. It never includes the value
or a path into it. A failed read is reported as a fixed message that includes nothing from the
library's error.

## Header layering

Headers are applied in this order. Later ones override earlier ones.

1. Driver defaults (`Accept`, and `Content-Type` for a body).
2. The driver's static `headers`.
3. The operation's input-mapped headers, or a handler's call headers.
4. The authentication's headers.

The headers an auth part declares are reserved before operations compile. A static header, a
parameter mapping or a handler's call that names one of them fails. The first two fail at
creation. A handler's call fails as `INTERNAL`. This means mapped input cannot replace what the
gateway authenticates with. An auth part may not set a header it did not declare.

## Build-time check

The definition also carries `checkSchemas`. Codegen calls it with the configuration and the
schemas before it emits anything. See
[What codegen checks](/flex-platform/drivers/openapi-rest/overview/#what-codegen-checks).
