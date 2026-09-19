# Gateways

Gateway libraries separate an upstream's operations from shared validation, dispatch, timeouts
and logging. Each gateway configuration describes one upstream.

## Package responsibilities

```txt
gateways/
  shared/
    config/        defineGateway, driver definition and executor contract, policy presets
    types/         Envelope shapes, error codes, Validator, driver contract, schema and secret shapes
    runtime/       Envelope parsing, dispatch, timeouts, bindings, logging and secret retrieval
    codegen/       Schema loading, configuration checks, validators, contract and entry point
  drivers/
    openapi-rest/  HTTP request construction, status mapping, authentication and custom handlers
  services/
    udp/           Example gateway configuration and schema fixtures
```

The codegen CLI checks a gateway configuration against its schemas and writes the validators,
the call contract and the entry point to `.gen/`; see [Code generation](#code-generation). For
the included example, run:

```bash
pnpm --filter @govuk-once/flex-gateway-udp codegen
```

There is no build step: the CLI runs from source. It does not generate a client; a consumer
takes the generated contract and invokes the deployed gateway itself. The runtime's
`createHandler` accepts validators keyed by the configuration's operations and an execution
function, compiles once, and returns a handler that takes each invocation's deadline; the
openapi-rest driver's `createExecutor` supplies the execution function once it has retrieved
and validated the gateway's secret. Outcome validators are held in a `Map`, so an outcome name
matching an inherited object member such as `constructor` cannot pass validation.

Configuration is checked for shape as well as content: a misspelled operation, gateway or
driver field is a type error at `defineGateway` or the driver helper, not a silently ignored
key.

The upstream must be reached over https. An http target is accepted only for a loopback host,
so a local stub or a sidecar that terminates TLS still works while a remote address cannot be
configured in cleartext.

Token and signature verification of the caller are not implemented. Secure bindings check
consistency of values only. Of the configured policy settings, only `upstreamTimeout` is
enforced. Authentication towards the upstream is configured per gateway on its driver
definition; see [Authentication](#authentication).

## Gateway configuration

`defineGateway` preserves operation names in the inferred type and supplies policy defaults.
The [UDP gateway](services/udp/gateway.config.ts) describes the User Data Platform API using
the [openapi-rest driver](#the-openapi-rest-driver). Its upstream takes no credential, so it
declares `noAuth()`; its deployment still names a secret, which must be the empty object.

```ts
import { defineGateway } from "@repo/gateway-config";
import { noAuth, openapiRest } from "@repo/gateway-driver-openapi-rest";

import getIdentityExchange from "./handlers/get-identity-exchange.ts";

export default defineGateway({
  id: "udp",
  description: "User Data Platform gateway",
  driver: openapiRest({
    spec: "https://raw.githubusercontent.com/govuk-once/user-data-platform/refs/heads/main/docs/openapi.yml",
    auth: noAuth(),
  }),
  operations: {
    createUser: {
      description: "Create User Record",
      upstream: "POST /v1/user",
    },
    getIdentityExchange: {
      description: "Look up a linked identity record for a different service",
      upstream: "GET /v1/identity/exchange",
      parameters: { subjectId: { in: "query" } },
      handler: getIdentityExchange,
    },
  },
});
```

| Gateway field | Purpose |
|---|---|
| `id` | Required non-empty gateway identifier. |
| `description` | Optional description. |
| `driver` | Required driver definition; determines additional operation fields. |
| `policy` | Optional overrides for `standardPolicy` defaults. |

| Operation field | Purpose |
|---|---|
| Driver-specific fields | Defined by the driver type, such as `upstream` and `parameters` above. |
| `description` | Optional description. |
| `log` | Optional input and output field allowlists. |
| `secure` | Optional mappings from input paths to envelope secure-value keys. |
| `handler` | Optional custom handler, a value from the driver's `defineHandler`, typed against the driver. The runtime and CLI ignore it; the driver's executor dispatches to it. |

### Policy

`upstreamTimeout` accepts a positive duration such as `"500ms"`, `"3s"` or `"1m"`. The default is
`"10s"`. An upstream attempt uses the smaller of this timeout and the remaining request budget;
an exhausted budget prevents dispatch.

The configuration also accepts `circuitBreaker.threshold`, `circuitBreaker.duration`
and `rateLimit.rps`. These fields have no enforcement effect in the current runtime.

### Logging

`log.input` and `log.output` select request and response payload fields to include in response
logs. Omitting an allowlist selects no payload fields from that side.

```ts
log: {
  input: ["recordId"],
  output: ["status", "address.postcode", "results.*.name"],
}
```

Paths use dot notation. A wildcard expands across array entries or object values. Only scalar
matches are logged: a path resolving to an object or array is dropped, and so is a number JSON
cannot write, since `NaN` and the infinities reach a log as null and would read as a field that
was null rather than one that was not logged. A field that is null is logged as null. Name
`address.postcode` instead of `address` so newly added nested fields are not logged automatically.

These allowlists govern selected payload fields. Diagnostic messages require separate care and
must not include sensitive values. An input that fails validation is logged as the schema
locations that rejected it and the keywords' own messages, never as a path into the input: a
dictionary schema takes such a path's segments from the caller's keys, which no allowlist
selected.

### Secure bindings

Bindings require input fields to equal named values in `secure.values`. They do not currently
verify a signature or establish the origin of those values.

```ts
secure: { "actor.id": "sub" }
```

The key is an exact dot path into the input; the value is a key in `secure.values`. Comparisons
are strict, with no coercion. A missing input field, a missing secure value or a mismatch produces
`SECURE_VALUE_MISMATCH`. Malformed paths, wildcard paths and empty secure keys are rejected when
creating the handler.

Secure values must be strings, finite numbers, booleans or null. Other values produce
`INVALID_INPUT`. The scalar restriction keeps payload preparation simple and deterministic.
The envelope requires a string `secure.signature`, but the runtime does not verify it.

## Code generation

`gateway-codegen` runs in a gateway package, loads `gateway.config.ts` and writes everything
generated to `.gen/`, in two directories because the two are deployed separately: `runtime/` is
what the gateway itself runs and `client/` is what a service calling it imports. Schemas come
from the driver's `deriveSchemas` when it has one and from the gateway's `schemas.fixture.ts`
otherwise; no driver implements `deriveSchemas` yet.

| Path | Contents |
|---|---|
| `.gen/runtime/entry.js` | The handler: the configuration, the validators and the executor the driver builds. Reads the environment and exports `handler`. |
| `.gen/runtime/validators/` | Standalone Ajv validators, one for each operation's input and one for each declared outcome. Self-contained JavaScript with no package imports. |
| `.gen/runtime/bundle.mjs` | `entry.js` and everything it imports, bundled by esbuild as ESM for Node 24, with the AWS SDK left to the Lambda runtime. The deployed artifact; its handler is `bundle.handler`. |
| `.gen/client/rpc.ts` | The call contract as types: each operation's input and the union of its outcomes. Types only, so a consumer takes it without the gateway's dependencies. |

Generated code is not typechecked, and nothing outside `.gen/` imports it. A gateway package
holds a configuration, its schemas and any custom handlers; generation and dispatch are covered
by the libraries' own tests, against a fixture gateway in `gateways/shared/codegen/test/`, so a
new gateway adds no test of its own beyond its handlers.

Nothing is published unless the whole run succeeds. The configuration is checked against the
schemas first, and everything is then built in a directory of the run's own beside `.gen/` and
moved into place only once the last step has finished, so a run that fails leaves what the last
complete one produced rather than a gateway whose two halves came from different schemas. The
output being replaced is moved aside rather than deleted, so even a failure to publish leaves the
last complete run in place; removing it once the new output is in place is tidying, and a
filesystem that refuses it leaves that directory behind rather than turning a published run into a
failed one. A run is given a gateway's directory rather than a configuration: it reads
`gateway.config.ts` and `schemas.fixture.ts` itself, from the bytes on disk rather than from
whatever a process loaded earlier, because the entry point imports the configuration and esbuild
reads it again when it bundles. What those two import is another matter: Node serves a module it
has already evaluated and nothing here can evict one, so a gateway is generated once per process,
which is what the command does. Every module the gateway is made of is read again once the output
is built, and a file that changed while the run was in progress fails it before anything is
published: what was checked would not be what the bundle runs. One run at a time per generated
directory: nothing coordinates two, and a gateway is generated by one command. The bundle is built
during generation rather than at deployment, so a gateway that cannot be bundled fails where the
cause is at hand, and the same gateway bundles to the same bytes.

### What codegen checks

Each operation must have schemas and each set of schemas an operation, and every operation must
declare at least one outcome. Whether an operation's mappings and its input schema describe the
same request is the driver's own reading, through `checkSchemas` on its definition; the generator
names no method, path, query parameter or header. For the openapi-rest driver, codegen fails
when:

- a `{param}` in the template has no `parameters` entry with `in: "path"` naming it, or an entry
  names a parameter the template does not declare;
- a mapped field, for a path, query or header parameter, is not a field of the input schema;
- an input field is neither mapped nor `payload`, so nothing would carry it upstream;
- a path parameter's input field is not required by the schema, which would leave a segment of
  the path with no value;
- two fields supply one path parameter, query parameter or header, so only one would be sent;
- the input schema declares `payload` for a method that cannot carry a body, or a mapping names
  a header the gateway's authentication owns.

Each of these is otherwise a failure when the executor is created or an `INTERNAL` failure on a
request that reached production. The messages name every problem found in one run.

An operation with a `handler` builds its own request, so what the automatic mapping would need of
its input schema is not checked for it: an unmapped field, a mapping naming a field the schema
does not declare, a path parameter whose field the schema leaves optional, and a `payload` the
method could not carry are the handler's to decide: it calls `prepare` with an object it builds,
if it calls it at all. What the executor compiles for every operation is checked either way — the
template's parameters, the names a mapping takes, the headers authentication owns. A handler that
calls `prepare` is bound by the mapping after all, and the runtime reports that as `INTERNAL`;
nothing at generation can tell the two apart.

Schemas are compiled before any of this is read, so a schema that is not a valid schema is
reported as itself rather than as whatever the checks above make of it; the output is written only
once both have passed. Compilation is in Ajv's strict mode, so a misspelled keyword or a
constraint that applies to nothing fails generation rather than passing silently. One check is
off: strict mode wants a tuple's length pinned, which would refuse an array that types its first
elements by position and the rest with `items`. A schema whose validation is asynchronous is
refused outright, since the dispatcher validates synchronously.

### The generated entry point

```js
// .gen/runtime/entry.js
import { createHandler, readUpstreamOptions } from "@repo/gateway-runtime";

import config from "../../gateway.config.ts";
import { validators } from "./validators/index.js";

const execute = await config.driver.createExecutor(config, readUpstreamOptions());
const gateway = createHandler(config, { validators, execute });

export const handler = (event, context) =>
  gateway(event, {
    deadline: { remainingMs: () => context.getRemainingTimeInMillis() },
  });
```

It is the same module for every gateway: the driver arrives as part of the configuration and
builds its own executor, so nothing here names a driver package or a transport. `UPSTREAM_TARGET`
and `UPSTREAM_SECRET_ARN` are read here and nowhere else, and the handler is built while the
module loads, which is the platform's initialisation phase, so the operations compile and the
secret is retrieved and validated before any request rather than during the first one. The
handler is the only export: a gateway runs on Lambda and the platform is its only caller.

It is JavaScript, not TypeScript, for the same reason the validators carry no declarations: a
TypeScript module could not import them.

The bundle carries everything the handler imports except Node's builtins and the AWS SDK, which
the Lambda runtime provides. Its handler is `bundle.handler`. A bundled CommonJS dependency
reaches those builtins through `require`, which an ES module does not have, so the bundle opens
with one of its own from `node:module`; without it the module would throw as it loaded rather
than fail a request.

### The call contract

`.gen/client/rpc.ts` describes what a caller sends and receives. Each operation's input is one flat
object: the fields the operation maps to the upstream request at the top level, and the request
body, when there is one, under `payload`. Each response is an error envelope or a success
carrying one of the declared outcomes, so a switch over `outcome` is checked for exhaustiveness
and an outcome the gateway does not declare is a type error.

```ts
import type { GetIdentityExchangeResponse } from "./.gen/client/rpc.ts";

export function linkedId(response: GetIdentityExchangeResponse): string | null {
  if (!response.ok) throw new Error(response.error.code);
  switch (response.outcome) {
    case "ok":
      return response.data.linkedId;
    case "unlinked":
      return null;
  }
}
```

`Operations` maps each operation name to its input and result, and `OperationName`,
`OperationInput`, `OperationResult` and `OperationResponse` name them generically.
`GatewayRequest` is one call as the handler receives it: the operation, its input and the
envelope's `secure` values.

A schema often states one shape in several places: `properties` here, `required` there, more of
both inside `allOf`, and the rest behind a `$ref`. TypeScript has no equivalent of "this keyword
applies only when the value is an object", so the object keywords a composition contributes
become one declaration and everything else is intersected around it; a reference keeps its name.
`anyOf` and `oneOf` become unions, each branch read against what encloses it, so a field the
schema requires stays required inside every branch and a schema that also admits null keeps
admitting it. An array whose front `prefixItems` types becomes a tuple, with the elements a length
does not require left optional. Where a composition has more ways through than are worth writing
out, the generated type is the wider one: it never rejects a request the gateway accepts, and the
validators remain what enforces the schema.

A `$ref` names a key of the gateway's shared `defs`, which the contract declares as a type of that
name. A pointer into the schema itself, such as `#/$defs/Body`, compiles to a validator but has no
name to emit here, so generation fails rather than describing it as `unknown`: declare the
subschema in `defs` and reference it by that key, and both readers take it from one declaration.

An object the schema does not close carries an index signature. Leaving `additionalProperties` out
admits every other name, exactly as writing `true` does, so the type has to admit them too;
`additionalProperties: false` is what narrows it to the fields it names, which is worth setting on
an input, since a field no `parameters` entry maps fails the request as `INTERNAL`. A field the
schema requires but describes nowhere is named as `unknown`, so a request the validators would
reject does not typecheck. A schema nested more than 100 levels deep fails generation rather than
emitting what it can: nothing written by hand nests that far, and a reference costs no depth at
all.

## The openapi-rest driver

`@repo/gateway-driver-openapi-rest` is the only package that knows HTTP: methods, paths, status
codes and headers live here. The runtime and codegen see opaque driver metadata and an execution
function.

The package is split by when its code runs. `src/config/` holds what a gateway configuration
imports and what codegen calls: the driver and authentication definitions, `defineHandler` and
the build-time check of an operation against its schemas. Codegen evaluates these when it loads
a configuration, and nothing in them reaches the network or a secret. `src/runtime/` holds the
executor and everything under it, reached only through the definition's `createExecutor`, which
imports it on first call; a lint rule stops `config/` and the shared modules from importing it
statically. The shared modules at the top of `src/` are the vocabulary both sides use: the
client and handler types, the upstream template parser, header rules and path parameter
encoding.

### Input convention

A caller sends one flat `input` object and does not know which fields become path parameters,
query parameters or headers. The operation declares that per input field, in the OpenAPI
document's own vocabulary. The request body, when there is one, travels under the top-level
`payload` field.

| Operation field | Purpose |
|---|---|
| `upstream` | `"<METHOD> /path/{param}"`. Methods: GET, POST, PUT, PATCH, DELETE. |
| `parameters` | Input field to `{ in, name? }`. `in` is `path`, `query` or `header`; `name` is the upstream parameter or header when it differs from the field. Every `{param}` in the template needs an entry with `in: "path"`. |

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

Read `parameters` against the operation's input schema: every schema field appears there or is
`payload`, and every template parameter appears there with `in: "path"`. A template parameter
without an entry that names it, or a path entry naming a parameter the template lacks, is a type
error at `defineGateway`, a failure at executor creation, and a generation failure. The type
error reports the corrected `parameters` shape: a missing entry keyed by the parameter, or an
entry whose `name` must be one of the template's. Codegen sees the schemas as well, so it also
reports a mapping for a field the schema does not declare and a field the request would not
carry; see [what codegen checks](#what-codegen-checks).

Every input field must be mapped or be `payload` wherever the request is built from the mapping;
an unmapped field is a configuration error and fails the request as `INTERNAL`. That diagnostic
counts the unmapped fields and never names them: a schema that allows additional properties lets
the caller choose the names, so a field the schema declares is reported by codegen and one the
caller invented is only counted. Path values must be scalars and are percent-encoded as one
segment. Values that are only dots, or that contain `/`, `\`, `?`, `#`, `%` or a control
character, are rejected: this gateway's URL parser would collapse `..`, and an upstream that
decodes before it routes would reinterpret the rest, sending `../../admin` to `/admin` with the
gateway's credentials. Constrain path parameter formats in the input schema so callers receive
`INVALID_INPUT` rather than relying on this check. Query values may be scalars or arrays of
scalars, arrays repeating the key. Null and undefined query and header values are omitted. A
`payload` on GET is an error. Bodies are JSON with `Content-Type: application/json`, and every
request sends `Accept: application/json`.

Configuration problems such as an unsupported method, a template parameter without an entry, an
entry naming a path parameter the template does not declare, two fields feeding one upstream
name, a reserved header (`content-type`, `content-length`, `host`, `transfer-encoding`,
`connection`), a mapping onto a header the authentication owns, or a handler that is not a
function fail when the executor is created. A misspelled key inside a parameter mapping is a
type error at `defineGateway`.

### Outcomes and errors

Status codes never reach the caller. Success statuses map to fixed outcome names, which are the
keys the schema's `outcomes` must use.

| Status | Outcome |
|---|---|
| 200 | `ok` |
| 201 | `created` |
| 202 | `accepted` |
| 204 | `no_content`, with `data: null` |

Any other status becomes an error code.

| Status | Code |
|---|---|
| 404 | `NOT_FOUND` |
| 401, 403 | `UPSTREAM_REJECTED`: the gateway's own credentials were refused |
| 429 | `RATE_LIMITED`, the same code as a gateway-side limit |
| other 4xx | `UPSTREAM_REJECTED` |
| 5xx | `UPSTREAM_ERROR` |
| 1xx, 3xx, other 2xx | `UPSTREAM_CONTRACT_VIOLATION` |
| transport failure | `UPSTREAM_ERROR` |
| 2xx body that is not JSON | `UPSTREAM_CONTRACT_VIOLATION` |

Redirects are not followed. Every request is one `ctx.upstream` attempt that includes
authentication, the request and reading the body, so the policy timeout bounds the whole
exchange; an aborted attempt is reported by the runtime as `UPSTREAM_TIMEOUT`. Nothing retries.
Bodies are buffered up to the driver's `maxResponseBytes` (1 MiB by default); a larger declared
or streamed body is cancelled and reported as `UPSTREAM_CONTRACT_VIOLATION`.

Diagnostic messages name the operation, its template, the status and header or field names,
never a resolved path, a header value or a body. The driver raises every request-time failure
of its own as a `GatewayError`, whose message is written to be logged and which the runtime
records as is. Anything else that escapes, a library exception or a custom handler's own error,
is logged by the runtime as its source locations and the dispatcher step that was running,
never its message, name, properties, cause or stack text, since a handler or library can put a
payload in any of them; the locations come from V8's structured frames, and only while the
stack has not yet been formatted. Within the attempt, library exceptions are still replaced
with controlled ones. `Headers` quoting an invalid value is one case; an authentication flow
failing with the request it was making, or the secret it read, is another, and nothing of that
error is kept. A failing flow is reported as `INTERNAL` unless it raised a `GatewayError` of
its own. A transport failure's name and system code appear in the `UPSTREAM_ERROR` diagnostic
only when they match a fixed set such as `TypeError` and `ECONNREFUSED`.

### Running the executor

Nothing here is called by hand, and nothing the entry point calls is specific to this driver.
A driver definition carries its own `createExecutor`, so the
[generated entry point](#the-generated-entry-point) reaches it as `config.driver` and awaits it
with the neutral `ExecutorOptions` from `@repo/gateway-config`. Those options are the target the
runtime reads from the environment and a provider for the secret it names, so the entry point is
the same for every driver and every gateway, and nothing outside the configuration names a
driver package.

| Executor option | Purpose |
|---|---|
| `target` | `UPSTREAM_TARGET`. For this driver an absolute https base URL with no query, fragment or credentials; http is accepted only for a loopback host. A path prefix is kept. |
| `secret` | A provider for the secret `UPSTREAM_SECRET_ARN` names, built by `readUpstreamOptions`. The driver's `auth` says what it must hold. |

Behaviour is configured on the driver definition, where it is reviewed with the gateway.

| Driver field | Purpose |
|---|---|
| `spec` | Location of the OpenAPI document. Recorded for review; never fetched. |
| `auth` | Required. How requests are authenticated and what the secret must contain; see [Authentication](#authentication). |
| `headers` | Static headers on every request, such as an API version. |
| `maxResponseBytes` | Largest response body to buffer. Defaults to 1 MiB. |

Creation is asynchronous. Configuration is checked first: a reserved or invalid name in the
auth definition's header list, a static header the authentication owns, a non-positive
`maxResponseBytes` or a `handler` that is not a function fails before anything is retrieved.
The secret is then retrieved through the provider and validated, and the authentication state
is built on it; a missing, unreadable or invalid secret rejects creation, so the deployment
fails at startup rather than on its first request. A diagnostic about the secret names the
schema locations that rejected it, never what it held or a path into it, whose segments a
dictionary schema takes from the secret's own keys; a read that fails is reported as a fixed
message with nothing of the library's error.

Headers layer in this order, later overriding earlier: driver defaults, the driver's static
headers, the operation's input-mapped or call headers, then the authentication's. The headers
an auth definition declares are reserved before operations compile: a static header, a
parameter mapping or a handler's call that names one fails, at creation for the first two and
as `INTERNAL` for the third, so mapped input cannot replace what the gateway authenticates
with. The authentication may set no header it did not declare.

The definition also carries `checkSchemas`, which codegen calls with the configuration and the
schemas before it emits anything; see [what codegen checks](#what-codegen-checks). The contract
reserves `deriveSchemas` as well, through which a driver will produce operation schemas from its
own description of the upstream. This driver does not implement that yet; codegen reads
`schemas.fixture.ts` until it does.

### Authentication

The `auth` field of `openapiRest` takes an authentication definition. Three come with the
driver:

| Definition | Secret | Sends |
|---|---|---|
| `noAuth()` | `{}` | Nothing. For an upstream that needs no credential; the deployment still names a secret. |
| `bearerToken()` | `{ "token": "..." }` | `Authorization: Bearer <token>` |
| `apiKey({ header })` | `{ "apiKey": "..." }` | The key in the named header. |

Each validates its secret strictly: the field must be a non-empty string that the transport
sends exactly as stored, so it may contain no control character other than tab and no leading
or trailing space or tab, which the `Headers` class would strip; and no other field may be
present, so a token placed in the wrong secret, or under a misspelled field, fails at startup.

A definition is data. It declares the validator for its secret, the header names it owns and a
`create` function that builds its per-executor state, and nothing in it reads a secret or
exchanges a token when the configuration is imported, so codegen loads a configuration without
an environment or AWS access. A custom flow is one more definition, written with `defineAuth`,
which types `create` from the validator. The validator follows the shared `Validator`
convention, so a generated standalone validator fits as well as a hand-written predicate:

```ts
import { defineAuth } from "@repo/gateway-driver-openapi-rest";
import { GatewayError } from "@repo/gateway-runtime";

// A Validator<{ clientId: string; clientSecret: string; tokenUrl: string }>.
import { isClientSecret } from "./client-secret.ts";

export const clientCredentials = defineAuth({
  validateSecret: isClientSecret,
  headers: ["authorization"],
  create: ({ secret, transport }) => {
    let token: { value: string; expiresAt: number } | undefined;
    return {
      async headers({ signal }) {
        if (token === undefined || token.expiresAt <= Date.now()) {
          const { clientId, clientSecret, tokenUrl } = await secret.get();
          const response = await transport.request(
            {
              method: "POST",
              url: tokenUrl,
              form: {
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: clientSecret,
              },
            },
            signal,
          );
          if (response.status !== 200) {
            throw new GatewayError("UPSTREAM_REJECTED", `Token endpoint returned ${response.status}`);
          }
          const body = response.json() as { access_token: string; expires_in: number };
          token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
        }
        return { authorization: `Bearer ${token.value}` };
      },
    };
  },
});
```

Concurrent requests on an expired token each exchange in this example; keep one pending
promise for the exchange when the token endpoint should see it once.

`headers` runs inside every request's attempt, so a secret read or an exchange counts against
the operation's timeout, and a request that runs out of budget stops waiting; a read the
runtime has already started completes on its own and fills the cache. `secret.get` returns the
current secret: the runtime reads it through Powertools Parameters, which serves a retrieved
copy for five minutes and reads again on the first call after that. Concurrent calls on a cold
or expired cache may each read; nothing coordinates them. Every value passes the definition's
validator before it is returned, on every read; one that fails is never returned, and the
operation fails instead, as `INTERNAL`, as it does when a read fails. Rotating the secret
therefore needs no restart: a built-in definition sends the new value on the first read after
the cache age. Token and session expiry are the flow's own concern.

`transport.request` is the only way a flow reaches the network. It sends one request with the
signal the flow was given, to an absolute URL or to a path on the target, with a JSON or a form
body, applies the response limit and returns the raw status, headers and body. It takes the same
transport rule as the target: https, or http only for a loopback host, since a token exchange
carries the credentials that obtain the credential.
Statuses are not mapped, since what a token endpoint's answer means is the flow's decision. A
flow's own `GatewayError` is reported as it is; any other error it raises is replaced with an
`INTERNAL` diagnostic that names the operation only. Nothing replays an upstream operation
after an authentication failure.

### Custom handlers

An operation with a `handler` bypasses the automatic mapping. A handler is a value produced by
the driver's `defineHandler`, set on the operation in the configuration; where it is written
is up to the author, with a module next to the configuration being the usual choice. The
compiler checks it against the driver's handler type, which the definition exposes through
`HandlerOf`. That type is branded with the driver's `type`, and only `defineHandler` produces
it, so a plain function or a handler written for another driver is a type error on that line.
`defineHandler` also lets the author name the input type. Both paths use the same client, so every upstream call still goes
through `ctx.upstream` once and maps transport errors the same way.

The UDP gateway's [identity exchange handler](services/udp/handlers/get-identity-exchange.ts)
turns the upstream's 404 into an `unlinked` outcome, which its schema declares alongside `ok`:

```ts
import { defineHandler } from "@repo/gateway-driver-openapi-rest";

export default defineHandler(async (input: { subjectId: string }, client) => {
  const response = await client.request(client.prepare(input));
  if (response.status === 404) {
    return { outcome: "unlinked", data: null };
  }
  return client.mapResponse(response);
});
```

The input annotation states what the operation's input schema describes, and the outcomes the
handler returns are inferred. Both stay on the handler's type, so calling it with the wrong
input is a type error and a generated contract can check them against the schemas. The schema
fixture is likewise keyed by the gateway's operations through `GatewaySchemas<Operation>`, so a
missing or misnamed operation fails to typecheck.

`prepare` builds the operation's automatic request, `request` sends it once and returns the raw
status, headers and body without treating 4xx or 5xx as errors, `mapResponse` applies the status
mapping above to a response already received, and `invoke` is `request` followed by
`mapResponse`. Map the response you have rather than calling `invoke` after `request`: that
would send the request again, duplicating any write. Build paths for hand-written calls with
`encodePathParam`, which applies the single-segment rule.

## Responses and errors

Success responses have the shape `{ ok: true, outcome, data }`. Failures are
`{ ok: false, error: { code } }`. Error messages are logged, not returned, to keep diagnostic
detail out of the response contract.

`ERROR_CODES` defines the following meanings. A defined code does not imply the corresponding
control is implemented: authentication, signature verification, circuit breaking and gateway-side
rate limiting do not currently emit their reserved errors automatically. Which upstream responses
produce which codes is a driver decision; see the openapi-rest driver above.

| Code | Meaning |
|---|---|
| `INVALID_INPUT` | Envelope parsing or input schema validation failed. |
| `OPERATION_NOT_FOUND` | The gateway does not define the requested operation. |
| `UNAUTHENTICATED` | Authentication failure. |
| `SECURE_VALUE_MISMATCH` | An input binding is missing or does not match its envelope value. |
| `SECURE_SIGNATURE_INVALID` | Signature verification failure. |
| `NOT_FOUND` | The upstream has no matching record. |
| `UPSTREAM_REJECTED` | The upstream refused the request. |
| `UPSTREAM_ERROR` | The upstream failed to answer for a server or transport reason. |
| `UPSTREAM_TIMEOUT` | The attempt timed out or had no remaining budget. |
| `UPSTREAM_CONTRACT_VIOLATION` | The result failed outcome validation. |
| `UPSTREAM_UNAVAILABLE` | An upstream call was prevented by a gateway availability control. |
| `RATE_LIMITED` | A rate limit rejected the call, whether the gateway's own or the upstream's. |
| `INTERNAL` | An unexpected gateway error. |

The runtime classifies errors for health reporting. Gateway-side rejections are neutral to
upstream health; upstream responses and failures have separate classifications.

## Design constraints

- Keep transport details in adapters. Make each upstream call with `ctx.upstream(fn)`; the
  runtime applies the timeout and passes an abort signal to `fn`.
- Keep deployment-specific addresses, credentials and environment names out of gateway code.
  A gateway names no secret ARN and no secret value; the runtime reads the secret and the
  driver validates it on every read before authentication code sees a field.
- Emitted validators have no package imports or type declarations. Their helpers are bundled
  during generation so they can run independently of codegen's installed dependencies.
- Keep transport vocabulary out of the generator. A relation between an operation and its
  schemas that only a driver can read belongs in that driver's `checkSchemas`.
- Preserve compatibility of established contracts. Incompatible changes require a distinct
  gateway identity.

See [CLAUDE.md](../CLAUDE.md) for contributor conventions and the rationale for these boundaries.
