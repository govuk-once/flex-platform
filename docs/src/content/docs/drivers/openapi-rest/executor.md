---
title: Driver settings and startup
description: The openapiRest settings, the executor options, header layering and what is checked at startup.
---

Behaviour is configured on the driver definition, so it is reviewed along with the gateway.
Deployment values, the target and the secret, arrive as executor options.

## Driver settings

| Field | Purpose |
|---|---|
| `spec` | Where the OpenAPI document is: an https URL, ideally pinned to a release or commit, or a path within the gateway's directory. `gateway-schemas` reads it. Codegen reads it only if it is a path, to check [what the driver derives](/flex-platform/codegen/checks/#what-the-driver-derives). Codegen never fetches a URL. Nothing reads it at runtime. |
| `auth` | Required. How requests are authenticated, as a list of parts (`[]` for none), and the secret fields each part reads. See [Authentication](/flex-platform/drivers/openapi-rest/authentication/). |
| `target` | A secret field that holds the upstream's address, such as `fromSecret("apiUrl")`, for an upstream whose secret includes it. If both are set, it is used instead of `FLEX_UPSTREAM_TARGET`. Either follows [the same rules](/flex-platform/drivers/openapi-rest/overview/#the-upstream-must-use-https). If neither is set, the executor refuses to start. The driver reads it when the executor is created. |
| `headers` | Static headers sent on every request, such as an API version. |
| `metadata` | What the gateway reports beside a result, read from response headers. See [Response metadata](/flex-platform/drivers/openapi-rest/metadata/). |
| `maxResponseBytes` | The largest response body to buffer. Defaults to 1 MiB. |

## Executor options

The [generated entry point](/flex-platform/codegen/entry-point/) passes these options. It reaches
the driver as `config.driver` and awaits `createExecutor` with the neutral `ExecutorOptions`.
Nothing here is called by hand, and nothing the entry point calls is specific to this driver.

| Option | For this driver |
|---|---|
| `target` | `FLEX_UPSTREAM_TARGET`, if it is set. See [the upstream must use https](/flex-platform/drivers/openapi-rest/overview/#the-upstream-must-use-https). |
| `secret` | A provider for the secret that `FLEX_UPSTREAM_SECRET_ARN` names. The driver reads only the fields its `target` and `auth` name. |
| `log` | Where the driver logs while the executor is created. |

## Startup

Creating the executor is asynchronous. If the configuration or the initial secret checks fail,
the gateway does not start. Later secret reads, authentication exchanges and upstream calls can
still fail during a request. Creation runs in three steps.

1. **Configuration is checked.** Creation fails before anything is retrieved if there is:
   - an `auth` part that is not a definition;
   - a reserved or invalid name in a part's header list;
   - a header that two parts own;
   - a static header with an invalid name or value, one the driver sets, or one the
     authentication owns;
   - `metadata` the driver cannot read;
   - a `target` that is not a `fromSecret` field;
   - a `maxResponseBytes` that is not a positive integer;
   - a `FLEX_UPSTREAM_TARGET` that breaks
     [the target's rules](/flex-platform/drivers/openapi-rest/overview/#the-upstream-must-use-https).
     It is checked if it is set, even when a `target` field will replace it;
   - neither `FLEX_UPSTREAM_TARGET` nor a `target` field.

   The driver then compiles every operation. Compiling fails on the
   [checks it makes at startup](/flex-platform/drivers/openapi-rest/overview/#what-is-checked-and-when).
2. **The secret is retrieved and validated.** Creation fails if the secret is missing, unreadable
   or not a JSON object, or if a field the configuration names breaks
   [the rules for secret fields](/flex-platform/drivers/openapi-rest/authentication/#secret-fields).
   An optional field that is absent is logged by name. The driver reads a `target` field's address
   here, and holds it to the same rules as `FLEX_UPSTREAM_TARGET`. If that field is optional and
   absent, and `FLEX_UPSTREAM_TARGET` is not set, creation fails here.
3. **Authentication state is built** on the secret, one instance per part. Each part's `create`
   must return an instance with a `headers` function.

A diagnostic about the secret names the field and the rule it broke. It never includes the value
or a path into it. A failed read is reported as a fixed message that includes nothing from the
library's error.

## Header layering

The driver applies headers in this order. Later ones override earlier ones.

1. Driver defaults (`Accept`, and `Content-Type` for a body).
2. The driver's static `headers`.
3. The operation's input-mapped headers, or a handler's call headers.
4. The authentication's headers.

The driver reserves the headers an auth part declares before operations compile. This means
mapped input cannot replace what the gateway authenticates with. If a static header, a parameter
mapping or a handler's call names a reserved header, it fails:

- a static header or a parameter mapping fails at creation;
- a handler's call fails as `INTERNAL`.

An auth part may not set a header it did not declare.

## Build-time check

The definition also carries `checkSchemas`. Codegen calls it with the configuration and the
schemas before it emits anything. For what it refuses, see
[What is checked, and when](/flex-platform/drivers/openapi-rest/overview/#what-is-checked-and-when).
