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
    udp/           The User Data Platform gateway: configuration and schemas
```

The codegen CLI checks a gateway configuration against its schemas and writes the validators,
the call contract and the entry point to `.gen/`; see [Code generation](#code-generation). For
the UDP gateway, run:

```bash
pnpm --filter @govuk-once/flex-gateway-udp codegen
```

There is no build step: the CLI runs from source. It generates no client library yet: a consumer
takes the generated contract, which is types alone, and invokes the deployed gateway itself. One
is planned, and the contract is what it would be built from; that is why the types a caller reads
are generated apart from what the gateway runs, rather than beside them. The runtime's
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
the [openapi-rest driver](#the-openapi-rest-driver). It sends no credential yet, so its `auth` is
`[]`; its deployment still names a secret, from which nothing is read.

```ts
import { defineGateway } from "@repo/gateway-config";
import { openapiRest } from "@repo/gateway-driver-openapi-rest";

export default defineGateway({
  id: "udp",
  description: "User Data Platform gateway",
  driver: openapiRest({
    spec: "https://raw.githubusercontent.com/govuk-once/user-data-platform/7ed6c9a3c57c06a64995eaae00195189f533926b/docs/openapi.yml",
    auth: [],
  }),
  operations: {
    createUser: {
      description: "Create User Record",
      upstream: "POST /v1/user",
    },
    getIdentityExchange: {
      description: "Look up a linked identity record for a different service",
      upstream: "GET /v1/identity/exchange",
      parameters: {
        requiredService: { in: "query" },
        requestingService: { in: "header", name: "requesting-service" },
        requestingServiceUserId: { in: "header", name: "requesting-service-user-id" },
      },
    },
    // …and each of UDP's other operations.
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
selected. The operation name is the caller's in the same way until it matches a configured
operation, so a request that named none is logged with no `operation` field and a message that
does not repeat what it sent; a recognised name is the gateway's own vocabulary and is logged.

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
from the gateway's `schemas/` directory; see [Schemas](#schemas).

| Path | Contents |
|---|---|
| `.gen/runtime/entry.js` | The handler: the configuration, the validators and the executor the driver builds. Reads the environment and exports `handler`. |
| `.gen/runtime/validators/` | Standalone Ajv validators, one for each operation's input and one for each declared outcome. Self-contained JavaScript with no package imports. |
| `.gen/runtime/bundle.mjs` | `entry.js` and everything it imports, bundled by esbuild as ESM for Node 24, with nothing but Node's builtins left for the platform to resolve. The deployed artifact; its handler is `bundle.handler`. |
| `.gen/client/rpc.ts` | The call contract as types: each operation's input and the union of its outcomes. Types only; its one import is a type import of `@repo/gateway-types` for the envelope shapes, erased on compile. That package is of this workspace and declares no dependencies of its own, so a consumer here needs neither the runtime nor the generator. |

Neither half is typechecked where it is written: no package takes `.gen/` into its TypeScript
project. Nothing outside `.gen/` imports the runtime half, the generated entry point being what
reads the validators and living there itself. `client/rpc.ts` is the exception, and the point of
it: the service that calls the gateway imports it and typechecks it with its own sources.

A gateway package holds a configuration, its schemas and any custom handlers; generation and
dispatch are covered by the libraries' own tests, against a fixture gateway in
`gateways/shared/codegen/test/`, so a new gateway adds no test of its own beyond its handlers.

Everything that can refuse a gateway runs before anything is written: the schemas compile, each
version follows the one before it safely and the configuration agrees with the latest. Only then
is `.gen/` deleted and written again, so a gateway refused for its schemas or configuration keeps
the output it had. What can still fail is writing and bundling; a run that fails there fails the
command and leaves an incomplete `.gen/`, which the next run replaces.

- **A run reads a directory, not a configuration.** It reads `gateway.config.ts` and the latest
  version in `schemas/` from the bytes on disk rather than from what a process loaded earlier,
  because the entry point imports the configuration and esbuild reads it again when it bundles.
- **A gateway is generated once per process.** Node serves a module it has already evaluated and
  nothing here can evict one, so what the configuration imports would be stale on a second run.
  The command does one.
- **One run at a time per generated directory.** Nothing coordinates two, and a gateway is
  generated by one command.
- **The bundle is built during generation, not at deployment.** A gateway that cannot be bundled
  fails where the cause is at hand, and the same gateway bundles to the same bytes.

### Schemas

A gateway's schemas are kept beside its configuration as JSON, one file for each version:

```txt
schemas/
  0001.json
  0002.json
```

Codegen generates from the highest-numbered version, and a merged version is never changed or
removed: a change to the contract is the next version. Each version is checked against the one
before it as the files are now, so one rewritten in place would move what the check starts from;
CI refuses a pull request that changes or removes one. Versions are four digits, numbered from
`0001` with none left out, so the names sort into the order they were written in; a directory
that holds anything else, or whose numbering has a gap, fails generation rather than being read
around. A version holds the shared definitions and, for each operation, an input schema and a
schema for each outcome:

```json
{
  "defs": { "UserRecord": { "type": "object" } },
  "operations": {
    "createUser": {
      "input": { "type": "object" },
      "outcomes": { "created": { "$ref": "UserRecord" } }
    }
  }
}
```

A version is data: it is parsed, never imported, so reading one evaluates nothing, and an earlier
version stays readable however the configuration has changed since. Nothing typechecks a JSON
file, so codegen checks its shape when it reads it and reports everything wrong in one run. An
unknown field is refused, since a misspelt one would otherwise be ignored, and so is the name
`__proto__`, which JSON makes an ordinary key and an object literal does not: not as a definition,
an operation or an outcome, and not anywhere inside a schema, where Ajv skips a property of that
name rather than compiling it, reads a required one off the prototype, and writes the schema back
out as an object literal that the key would reshape. A character that does not display is refused
wherever a version holds one, in a name or a value: control characters, and the format characters
that reorder or hide the text around them. A version is reviewed by a person and its text is
written into generated code, so one of these would let it show a reviewer one thing and hold
another; it is read from the parsed value, so one written as a `\u` escape is found as well.
Whether each schema is a valid schema is Ajv's to say when the validators are built.

#### Bringing a gateway's schemas up to date

`gateway-schemas` runs in a gateway package, as `gateway-codegen` does, and `pnpm schemas` runs
it for every gateway, carrying on past one that fails. A person runs it, reads what it says and
commits what it wrote; it reaches the network, so nothing runs it in CI, where codegen's
comparison of the committed versions is what holds.

A driver that can derive its schemas gives the module that does as `deriveSchemasModule` on its
definition: a `file:` URL it builds from its own module,
`new URL("../derive/index.ts", import.meta.url).href`. It is a URL and not an import because a
generated entry point imports the configuration and the bundler follows every import it can see
from there, a dynamic one included: a module imported by the definition would carry whatever
parses the upstream's description into the deployed gateway. Built from the driver's own module,
it finds the driver's files wherever they are installed, with nothing to resolve. The command
loads it and calls the default export with the configuration and the one thing it may read a
description through: `load`, which fetches over https, following no redirect, or reads a path
within the gateway's directory. What arrives over https is counted as it arrives and the
connection dropped at 16 MiB, so the limit bounds what is held rather than what a host sends.

What comes back is held to everything a version on disk is held to, the shape, each schema
compiling as the validators compile it and agreement with the configuration, before it is
compared with the latest version:

| Upstream | What the command does |
|---|---|
| Its shape is what the latest version holds | Writes nothing. A reworded `description` is not a change of shape, so the contract's comments can lag the upstream's until its shape next changes. |
| Its shape changed and no caller breaks | Writes the next version, in the order it was derived in, and lists the changes. |
| A change would break a caller | Writes nothing, says so loudly with every break, and fails. The latest version stays what the gateway is generated from. |
| The gateway has no versions | Writes `0001.json`. |

A version is two-space JSON in the order its source was written in, so the contract lists an
object's fields as the upstream documents them, and nothing a formatter decides, so the same
schemas are the same bytes whatever is installed. The file is created exclusively, so a version
that exists is never written over, and of two runs racing for one version only one writes it. A
gateway whose driver derives nothing keeps its versions by hand; for it the command writes none
and reads the latest as the generator reads it, since nothing else has.

What the command prints carries an upstream's own words — a field name through the comparison, a
driver's notes through its derivation — and writes any character that does not display as its
code point, so nothing it is given can move a terminal's cursor back over the report above it.
The error that stops a run goes out the same way: a version refused for its shape is refused
before anything reads its characters, and the diagnostic names the field that caused it.

#### Compatibility between versions

A caller written against one version has to survive the next, so codegen compares each version
with the one before it, all the way back, and fails when any step would break a caller. Reading
only the last step would let two versions added together hide a break in the first. The two
sides of a call run in opposite directions:

| | Breaks a caller | Safe |
|---|---|---|
| Input | Admitting less: a field that becomes required or is removed, a narrower type, a removed `enum` value, a tighter bound, a new `pattern` or `format`, an object that closes | Admitting more: an optional field on a closed object, a wider type, an added `enum` value, a looser bound |
| Outcome | Promising less: a field that is removed or stops being required, a dictionary that closes, a wider type, an added `enum` value, a looser bound | Promising more: an added field no dictionary already spoke for, a field that becomes required, a narrower type |
| Operations | One that is removed | One that is added |
| Outcomes | One that is removed, and one that is added, since a caller's switch over them was complete | |
| Shared definitions | One that is removed or replaced by another, since the contract exports each as a named type | One that is added |
| Metadata | A name whose schema promises less, as for an outcome | A name that is added or removed, since every name is optional to a caller |

Annotations such as `description`, `title`, `deprecated` and `examples` are not differences, and
neither is the order anything is written in, the branches of an `allOf`, `anyOf` or `oneOf`
included: a branch that only moved is matched with where it was, and one that changed is read
against what is left on the other side. `prefixItems` types the element at each place, so its order
is a difference. Annotations are annotations only where a schema goes: a property, a pattern, a
name a map such as `dependentSchemas` or `$defs` keys its schemas by, and a name a keyword such as
`dependentRequired` lists are each read as the name they are. A bound is read as what it is in
effect, so one written at the value its keyword means by saying nothing is no difference, and
`minContains: 0` removed is a bound arriving rather than one going, since an array with a
`contains` and no `minContains` has to hold a match. `const` and `enum` are read together where
both appear, since each restricts what the other admits.

An outcome may list the values it knows of beside a type it admits in full,
`anyOf: [{ "enum": [...] }, { "type": "string" }]`; those known values can change freely, because
the outcome admitted any string already. A field declared where a dictionary already governed the
name — through `additionalProperties` or a `patternProperties` entry — is compared against what
that dictionary said, so an outcome whose values were strings does not quietly gain a number.

A definition is compared on each side of the call it is used on, read from the schemas rather
than from what the comparison reached, so a composition that changed too much to place does not
carry the definitions its branches name past the check, and reading one as an input is never
reading it as an outcome. A definition reached under a `not`, an `if`, a `contains` with a
`maxContains`, or a branch of a `oneOf` is compared as neither side: negation turns admitting
more into admitting less, and nothing here says which way such a change lands, so any difference
in it is a break.

Subsumption between JSON Schemas is not decidable in general and nothing here attempts it. The
keywords above are read one by one; `allOf` and `anyOf` are read branch by branch; and a
difference in any other keyword, or one that does not fit, counts as a break. `oneOf` admits a
value exactly one branch admits, which is not what the call contract makes of it, and it is not
read as a union here: a branch that comes to admit more can take a value another already admitted
and leave two matching, which the whole then refuses, and a branch removed can leave a value that
matched two matching one, which it then admits. Every change to a `oneOf` runs both ways at once,
so only one whose branches say what they said, and name what they named, is read as saying the
same: a definition a branch refers to is frozen with it.

A change refused that was safe costs a look, where one accepted that was not costs every caller.
The check covers the schemas only: nothing compares the generated types across a change to the
generator, or the error codes, which live in `@repo/gateway-types`. A contract that has to break
takes a gateway of its own, under another id.

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

A field is one the object holds, never one it inherits. Every value a validator sees was parsed
from JSON, so `Object.prototype` is behind it and a schema naming `constructor`, `toString` or
any other member of it would otherwise be answered by the prototype: an object holding nothing
would satisfy a requirement for such a field, and fail a type stated for one, since what got
validated is the inherited function. The validators are generated to read own fields only, so
what a schema says of a field is said of the object in front of it.

### The generated entry point

```js
// .gen/runtime/entry.js
import { createHandler, createStartupLog, readUpstreamOptions } from "@repo/gateway-runtime";

import config from "../../gateway.config.ts";
import { meta, validators } from "./validators/index.js";

const execute = await config.driver.createExecutor(config, {
  ...readUpstreamOptions(),
  log: createStartupLog(config.id),
});
const gateway = createHandler(config, { validators, meta, execute });

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

The bundle carries everything the handler imports but Node's builtins, the AWS SDK included even
though the Lambda runtime ships one: an import left out is resolved from the runtime's copy at
whatever version AWS last patched in, and every other dependency here is pinned exactly. Its
handler is `bundle.handler`. A bundled CommonJS dependency reaches those builtins through
`require`, which an ES module does not have, so the bundle opens with one of its own from
`node:module`; without it the module would throw as it loaded rather than fail a request.

### The call contract

`.gen/client/rpc.ts` describes what a caller sends and receives. Each operation's input is one flat
object: the fields the operation maps to the upstream request at the top level, and the request
body, when there is one, under `payload`. Each response is an error envelope or a success
carrying one of the declared outcomes, so a switch over `outcome` is checked for exhaustiveness
and an outcome the gateway does not declare is a type error.

```ts
import type { GetIdentityExchangeResponse } from "./.gen/client/rpc.ts";

export function serviceId(response: GetIdentityExchangeResponse): string {
  if (!response.ok) throw new Error(response.error.code);
  switch (response.outcome) {
    case "ok":
      return response.data.serviceId;
  }
}
```

The contract carries what the schemas say about themselves as comments, which is what a caller's
editor shows: a `description`, or a `title` where there is none, in front of each shared
definition and each field, with `@deprecated` where the schema sets `deprecated`. A field that
only refers to a definition takes the definition's, since an editor shows a field's comment and
not its type's, and an outcome's describes the data it carries. An operation is described by the
`description` its configuration gives it. That text is not the gateway's own: a schema derived
from an upstream's document carries whatever the document said, and it is written into code a
caller compiles. So every comment is written one way, which keeps `*/` from ending it, writes
every `@` the text holds as the character reference `&#64;`, and writes each line of the text as
a line of one block comment; names and values reach the contract as string literals or checked
identifiers, never as text. An `@` opens a JSDoc tag wherever it stands, not only at the start of
a line, and escaping one with a backslash stops the compiler parsing the tag without stopping
`stripInternal` removing the declaration it marks, so none is left to read. An editor rendering
the comment shows the `@` back. A tag in the contract is one the generator wrote: `@deprecated`,
from a schema that declares itself deprecated.

A response is `ErrorResponse` or a success carrying one of the operation's outcomes. Where the
gateway reports anything [beside a result](#responses-and-errors), both carry
`meta?: ResponseMeta`, whose every field is optional; the shared envelope types take any name
under `meta`, since they describe every gateway, so the contract declares its own and a name the
gateway does not declare is a type error. A gateway that reports nothing has no `meta` in its
types at all.

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
does not require left optional. A composition with more ways through its `anyOf` and `oneOf`
branches than the generator writes out fails generation rather than being described loosely:
widening the type would leave a contract that compiles while admitting requests the gateway
rejects, and the schema is what wants looking at. Factoring the branches into a shared definition
stops the expansion, since a `$ref` is read as a name.

A union of a type and values of it, `anyOf: [{ "enum": ["Valid", "Revoked"] }, { "type": "string" }]`,
is how an outcome lists the values it knows of while admitting whatever else an upstream comes to
send. It is emitted as `"Valid" | "Revoked" | (string & {})`: written with a bare `string`,
TypeScript would read the whole union as `string` and forget the values. A caller's editor goes on
offering them, a switch over them does not compile without a `default` branch, and that branch is
where a value added later arrives, so adding one [breaks no caller](#compatibility-between-versions).
The compatibility check reads the union this way where the type is written in it; where the type
is behind a `$ref`, an added value is refused, which is the safe mistake. An `enum` on its own
stays the closed union it is, which is what an input wants.

The same union is read whichever way a schema writes it: the values and the type beside each
other, the type enclosing a union of them, or either of the two behind a `$ref`, whose name is
read back to the definition it points at. What a name is read for is the types the definition
declares, not the `type` it writes: one that also admits null, through `nullable` or a list, is
declared as a union with it, and a name standing for that is not the type to mark open — doing so
would take the null out and leave a caller unable to assign what the validators accept. A
definition that also admits null, or that is itself a reference or a composition, is not read
through, and the values are then lost to an editor, which costs a suggestion and types nothing
wrongly.

What this type does not do is narrow to a value on its own. `if (status === "Valid")` leaves
`"Valid" | (string & {})`, since the open branch admits that string too, so a function taking
`"Valid"` refuses what the comparison established; pass the literal rather than the variable. A
caller compiled against a plain `string` and given one of these types can stop compiling for that
reason, with the schemas unchanged, so it is worth saying before the types go out.

A `$ref` names a key of the gateway's shared `defs`, which the contract declares as a type of that
name. A pointer into the schema itself, such as `#/$defs/Body`, compiles to a validator but has no
name to emit here, so generation fails rather than describing it as `unknown`: declare the
subschema in `defs` and reference it by that key, and both readers take it from one declaration.

An object is described by the fields its schema declares and no others, unless the schema says it
holds more: `additionalProperties: true`, or a schema for the rest, gives it an index signature,
and leaving `additionalProperties` out does not. `patternProperties` types the names its patterns
match, and joins that signature where `additionalProperties` says what the rest carries — a schema
for it, or `false`, which admits nothing else at all. Left out, the patterns are left out with
every other unlisted name: an index signature is a promise about every name, and a schema that says
nothing about the names its patterns miss cannot make one. `{ "unmatched": 123 }` passes a
validator whose only pattern is `^x-`, and a signature typed from that pattern would have let a
caller read it as a string. To a validator, leaving it out admits every other name exactly as
`true` does, and that is what lets an outcome go on validating when an upstream adds a field; the
type stays what was declared, so a contract never offers fields that depend on the version of it a
caller has. What an upstream adds still reaches a caller, unvalidated and undeclared. On an input
the difference runs the other way: the compiler refuses an object literal with a field of its own
where the validator would have taken it, so `additionalProperties: false` is still worth setting on
an input, since it is the validator that decides, and a field no `parameters` entry maps fails the
request as `INTERNAL`. A field the schema requires but describes nowhere is named as `unknown`, so
a request the validators would reject does not typecheck. A schema nested more than 100 levels deep
fails generation rather than emitting what it can: nothing written by hand nests that far, and a
reference costs no depth at all.

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
scalars, arrays repeating the key; a space is written `%20` and a plus `%2B`, so no upstream reads
one as the other. Null and undefined query and header values are omitted. A
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
exchange; an aborted attempt is reported by the runtime as `UPSTREAM_TIMEOUT`. Nothing retries,
apart from the one replay of a GET after a refused credential described under
[Authentication](#authentication).
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
| `target` | `UPSTREAM_TARGET`, when it is set. For this driver an absolute https base URL with no query, fragment or credentials; http is accepted only for a loopback host. A path prefix is kept. |
| `secret` | A provider for the secret `UPSTREAM_SECRET_ARN` names, built by `readUpstreamOptions`. The fields the driver's `target` and `auth` name are all it reads. |
| `log` | Where the driver logs while the executor is created, from `createStartupLog`: the runtime's logger under the gateway's name, with a driver's fields under `driver`, as a request's context writes them. |

Behaviour is configured on the driver definition, where it is reviewed with the gateway.

| Driver field | Purpose |
|---|---|
| `spec` | Location of the OpenAPI document. Recorded for review; never fetched. |
| `auth` | Required. How requests are authenticated, as a list of parts, `[]` for none, and the secret fields each reads; see [Authentication](#authentication). |
| `target` | A secret field that holds the upstream's address, `fromSecret("apiUrl")`, for an upstream whose secret carries it. Used in place of `UPSTREAM_TARGET` when both are there, and held to the same rules; with neither, the executor refuses to start. Read when the executor is created. |
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
schemas before it emits anything; see [what codegen checks](#what-codegen-checks).

### Response metadata

`metadata` names what the gateway [reports beside a result](#responses-and-errors) and the
response header each is read from, with the schema of what it carries:

```ts
openapiRest({
  spec: "…",
  auth: [],
  metadata: {
    upstreamRequestId: {
      header: "X-Request-Id",
      schema: { type: "string", maxLength: 128, description: "The upstream's id for the request" },
    },
  },
});
```

A caller reads `meta.upstreamRequestId` and never sees the header's name, which is this
transport's. The schema is the gateway's own and is best kept loose: it is there to bound what
reaches a caller and a log, and an upstream that changes how its ids look has changed nothing a
caller relies on, so what an OpenAPI document says of a response header is not used. Every value is
returned to the caller and written to the log, so which headers to pass along is the gateway
author's decision, and a `maxLength` on each string keeps an unexpectedly long one out of both. A
header is text; one whose schema is a number, an integer or a boolean is read as that where the
text is one, and left as text where it is not, for the gateway's validator to refuse. Headers are
read as they arrive, before the body and before the status is mapped, so a response the driver
turns into an error code reports as a success does, and so does an exchange whose body was too
large or whose stream broke: what a caller most needs about a request that failed is the upstream's
own id for it. One that never arrived reports nothing. Deriving copies each schema into the
gateway's `meta`; codegen fails when a name is in the schemas and not in `metadata`, or the other
way round, or when the two disagree about what the header holds — the configured schema decides
what the text is read as and the stored one decides what validates, so a count read from a header
the schemas hold to a string would be dropped from every response without a word. The executor
refuses to start on `metadata` it cannot read.

### Deriving schemas

The driver derives a gateway's schemas from the OpenAPI document its `spec` names, when someone
runs [`gateway-schemas`](#bringing-a-gateways-schemas-up-to-date). `spec` is an https URL, best
pinned to a release, or a path within the gateway's directory; the document itself is never
committed, only what is derived from it. Parsing JSON or YAML, checking the document and
rewriting OpenAPI 3.0's dialect as 3.1's, which is JSON Schema 2020-12, are
`@scalar/openapi-parser`'s. The module that does this is `src/derive/`, which the definition
gives as the `deriveSchemasModule` URL and nothing a gateway imports reaches, a lint rule
included, so the parser is never part of a deployed gateway.

Only the operations the configuration declares are derived, each found by its `upstream` method
and path; an `operationId` is not used, since a document need not have one and one it has need
not be a name.

A document may serve paths it does not declare, through a template that takes every segment that
is left, such as `/v1/{resourcePath+}` for a store that keeps whatever it is given under whatever
path. An operation never takes such a parameter from a caller, which would let one operation
reach any other's endpoint past its schemas and its bindings. It names its path in full and says
which template serves it:

```ts
getNotificationPreferences: {
  upstream: "GET /v1/notifications",
  matches: "/v1/{resourcePath+}",
  narrow: { outcomes: { ok: { type: "object", properties: { data: NOTIFICATION_PREFERENCES } } } },
},
```

`matches` is said, never inferred: a path the document lacks fails deriving unless the operation
names what serves it, and the failure names the templates that could. Deriving then checks that
the template exists, that the path fits it, `{name}` taking one segment and `{name+}` one or
more, all written out, and that no more specific template fits, since that is the one the
upstream would route to; and it refuses `matches` on a path the document does declare. A path is
also refused where a router could read it as another: an empty segment, as a trailing or a
doubled slash writes, which a router may drop or merge, and a slash or a backslash written inside
a segment, as `%2F`, `%5C` or `\`, which one may decode into a separator. `GET /v1/sar/abc/`
fits `/v1/{resourcePath+}` as written, and reaches `/v1/sar/{sarId}` through a router that
ignores the trailing slash.

A path with parameters of its own is held to the same: the upstream routes on the value a caller
sends, so `GET /v1/app/{id}` reaches `/v1/app/admin` where the document declares one, and would be
answered by that endpoint while held to schemas derived from the template. Deriving refuses it
unless the parameter's schema refuses every value a request would write as that text: a list of
values, a type or a pattern, so `/users/{id}` beside `/users/me` derives where `id` is an integer
and is refused where it is any text. A schema the check cannot apply, a `format` nothing
implements say, proves nothing, and the path is refused. Where a path could reach another
endpoint, its text is compared as it reads: a template writes its segments as they go into a
URL, so `é` and `%C3%A9` are one segment, and a value of `admin panel` is one that reaches
`/v1/admin%20panel`. Fitting a path to the template it names compares the text as it is written,
which can only refuse more. A parameter is where a request puts one, which is the reading the
runtime uses: `{id}.json` is a parameter and text, and reaches `/v1/admin.json` but not
`/v1/notifications`. Fitting a path through such a segment is refused, since what of it the path
fills and what it keeps is neither one thing nor the other.

What the path fills of the template needs no input field: no caller supplies it, and the text it
writes is held to the document's schema for that parameter by the validators themselves, on the
same dialect and formats a gateway's are generated with. A segment is text, what it stands for
may be a number or a flag, and every reading of it is offered, so `/things/42` fills a parameter
of integers, `/things/a%20b` one whose values include `a b`, and a fixed identifier is written
out and held to its `format`. A number is only offered where the text is how that number is
written, since a request writes a value as that: `9007199254740993` is not, being what the number
written `9007199254740992` parses from, and neither are `007`, `42.0` or four hundred digits. A
parameter the document describes by its content rather than a schema is refused, as it is when a
caller supplies it. A schema saying something the check cannot apply, such as a `format` nothing
implements, refuses the value rather than admitting it on the rest, since what is left unapplied
is what the upstream will hold it to; one that would be checked asynchronously is refused rather
than run, since an answer that arrives later is not an answer here. This is the only check the
text gets: the parameter has left the input before generation or a request's validator could see
it. An ordinary parameter can be filled the same way, `GET /v1/identity/app/{id}` against
`/v1/identity/{serviceName}/{identifier}`, and one the path keeps goes by the path's name for it.
The request is sent to the path in `upstream` either way; only deriving reads `matches`.

A document may say only that a body, or a field in one, is an object of any shape, as such a
template's usually does. Left so, it stays open, and a caller's contract types it as
`Record<string, unknown>`. `narrow` states the shape a gateway's own services keep there:
`payload` for the request body, and `outcomes` by name. Where the document admits an object of
any shape, or any value at all, what is stated takes its place, at whatever depth it is, where
the object admits objects and nothing else — one that also admits null would admit what the
document did not. Where the document describes an object, what is stated of a field is set into
it, a field may be required or the object closed, and a field the document's object has no room
for is refused, as is every field of an object the document closes with none; a field the
document held through `additionalProperties`, as a dictionary does, keeps what held it, since
declaring a field exempts it from that. Anything else is set beside what the document says as an
`allOf`, which holds both whatever they say. What a narrowing says of what it narrows, its
description say, is kept over what the document says. A narrowed body is used as written, so it
is as strict as it is written to be. A narrowed outcome is held to its shape like any other, open
to fields and values it does not list and with no bounds, because what one of a gateway's own
services comes to keep there should fail no other's read of it. A narrowing is read in full before
any of it is set into a schema: its shape, so a keyword written as something other than what it
takes is refused rather than filtered out on the way and lost; the names it may not use; and a
`$ref` or `$dynamicRef`, which has nothing to refer to. Where a schema goes is the same reading
used wherever one is walked, so a `$ref` inside an `allOf` is found as surely as one at the top, a
field may be called `$ref` or `properties` and is the field it is, and `true` and `false` are the
schemas they are.

| From the document | In the gateway's schemas |
|---|---|
| A parameter the operation's `parameters` map | An input field under the configuration's name for it, with the parameter's schema and, where the schema has none, its description. Headers are matched without regard to case. |
| A required parameter nothing maps | The run fails. An optional one is left out, with a note. A cookie is never sent, so a required one fails the run and an optional one is a note. |
| A parameter the driver could not send as written | The run fails: an object anywhere, an array in a path or a header, an array whose elements are not scalars or whose tail nothing describes, an array a query does not repeat (`explode: false`), a `style` other than the one the driver writes, `allowReserved`, a required parameter admitting null, a required query array admitting one with nothing in it, a schema that admits a value of any type, or one that refers to itself. The driver writes a path and a header as one scalar and a query as a scalar or a repeated name; null is how a caller leaves a parameter out, so a required one may not admit it and a path parameter, always required, never may. An empty array leaves one out the same way, since the name is written once per element and no element writes no name, so a required query array has to say it holds something, through `minItems` or a `contains` it cannot satisfy while empty; the check reads that through the definitions a schema names and the branches it is written in, as it reads the types. What a parameter admits is read from the schema the conversion produced, which is what the validators are generated from, and through the definitions it names once those are converted too: reading the document a second time would say something else about the same parameter, since a keyword the declared type says nothing about is gone by then. A part that constrains nothing, written as `true` or as `{}`, admits every value and is carried as that, so a union holding one is refused rather than read as the narrow thing beside it. An array's elements are read the same way: one whose elements nothing describes admits every element, so beside a branch admitting strings a union admits every element and an `allOf` admits strings, and `items` left out past the elements `prefixItems` names describes none of the rest. |
| A request body | `payload`, always required: a body an operation declares is one its upstream expects, whatever a generator left out. `application/json` only: the driver sends that and nothing else, so a body offered only as `application/merge-patch+json` fails the run rather than being sent as something it is not. A response is parsed as JSON whatever its type says, so any of the `+json` family will do for one. |
| 200, 201, 202, 204 | The outcome the driver maps that status to. A 204, or a success with no body, is `null`. |
| 4xx, 5xx, `default` | Nothing: they reach a caller as [error codes](#outcomes-and-errors). |
| `#/components/schemas/Name` | The shared definition `Name`. Only definitions an input or an outcome reaches are kept, in the order the document declares them. Parameters, request bodies and responses written as references are resolved. |
| `security` | Nothing: how a gateway authenticates is its configuration's. |

The two sides of a call are converted differently, because they fail differently:

| | Input: what a caller sends | Outcome: what an upstream sends |
|---|---|---|
| An object that says nothing of other fields | Closed, so a field can be allowed later and never has to be disallowed. One inside `allOf`, `anyOf` or `oneOf` is left open, with a note: closing one part would refuse the fields the others declare. One that names no field at all is an object of any shape, which closed would admit only `{}`: it is left open, with a note, and the contract types it as `Record<string, unknown>` until an operation's [`narrow`](#deriving-schemas) states its shape. | Left open, and one the document closes is opened, so an upstream that adds a field does not fail its responses. What it adds reaches a caller undeclared; [the contract does not offer it](#the-call-contract). |
| `enum` | Kept exactly. | Becomes the values it knows of beside the type that admits the rest, `anyOf: [{ "enum": [...] }, { "type": "string" }]`, so a value the upstream adds breaks no caller. A single listed value on a field of a union's branch stays as it is, since it is what tells the branches apart; `const` is never opened. |
| Bounds, `pattern`, `format` | Kept exactly. | Dropped: an outcome is held to its shape, the types, the fields and which are required. `minContains: 0` is kept, with the `maxContains` a validator wants beside it: left out, `minContains` is one, so dropping a zero is a bound arriving rather than one going. |
| A definition both sides use | Takes a name of its own, `NameInput`, where the two sides hold it differently, and so does whatever refers to it from an input. Renaming reaches the places a schema holds a schema and no others: a `const`, an `enum` or a `default` holding an object of its own keeps every key it was written with, including one called `$ref`, which is a value the caller sends rather than a reference to follow. | Keeps the document's name. |

A definition is converted once and stands for every place it is named, so it is converted for
the strictest of them: one named inside a composition anywhere is left open everywhere, and one
named as a branch of a union keeps what tells it from the others. A schema written out and the
same schema written as a name therefore hold a value the same way.

Every conversion above moves what a schema admits one way on purpose, and there are places where
that turns around: under a `not`, under an `if`, under a `contains` a `maxContains` counts, and
under a `oneOf` whose branches nothing tells apart, where a branch that came to admit more could
take a value another already admitted and leave the whole refusing what two of its branches
match. There the upstream's schema is kept exactly as written, with a note; where it declares no
type beside keywords that need one, neither keeping it nor supplying the type is safe and the
run fails. A `oneOf` is told apart by its branches where every one of them is an object that
requires a field fixed to a scalar of its own, and no two fix it to the same: that field goes on
telling them apart whatever else is opened. A tag a branch may leave out is no tag, since a value
omitting it matches every branch, and a tag fixed to an object is no tag either, since two
objects that are the same value need not be the same text. The elements of a `prefixItems` tuple
are schemas in their own right, not parts of a composition: an ordinary object among them is
closed like any other input object.

On either side, what JSON Schema has no keyword for is left out (`example`, `xml`, `externalDocs`,
`discriminator`, `x-` extensions); `nullable` is read by what it says rather than by being
written, so only `nullable: true` adds null and it adds none with no type beside it to add to,
whichever order the two were written in; a schema whose keywords are those of one type and which
declares none is given it; and a keyword the declared type says nothing about is dropped. The last
two are documents an upstream's own tools accept and the validators' strict mode refuses. Each is
noted in what the command prints, for whoever reviews the result, and everything that cannot be
derived at all is reported together and fails the run.

### Authentication

The `auth` field of `openapiRest` lists how a request is authenticated, in order, and `[]` for an
upstream that takes no credential. Each part names the headers it sets and the fields of the
gateway's secret it reads, and is shown the headers the parts before it set, so a signature can
cover a key. Two parts come with the driver:

| Part | Reads | Sends |
|---|---|---|
| `apiKey({ header, key })` | `key` | The key in the named header. |
| `sigV4({ service, region, role })` | `role.arn`, `role.externalId`, and `region` where it names a field | An AWS Signature Version 4 over the request, in `Authorization`, `X-Amz-Date` and `X-Amz-Security-Token`. It owns `X-Amz-Content-Sha256` as well, and sets none. |

A value a part reads from the secret is named by its field, with `fromSecret("field")`, or
`fromSecret("field", { optional: true })` for one the secret's owner does not always provide.
Nothing has a default: a secret may be the gateway's own, or one the upstream provides in a shape
of its own, and only the configuration says which field means what. A field that is required
and missing stops the gateway starting; one that is optional and missing is logged by name as
the gateway starts, and what reads it goes without, a header left out or `UPSTREAM_TARGET`
used instead. Mark a field optional only where going without it is a valid deployment: an
upstream that still expects the header refuses every request instead. A credential takes only
`fromSecret`, so none can be written into a configuration. UDP, whose secret is UDP's own:

```ts
openapiRest({
  spec: "…",
  target: fromSecret("apiUrl"),
  auth: [
    apiKey({ header: "x-api-key", key: fromSecret("apiKey") }),
    sigV4({
      service: "execute-api",
      region: fromSecret("region"),
      role: {
        arn: fromSecret("consumerRoleArn"),
        externalId: fromSecret("externalId", { optional: true }),
        sessionName: "udp-consumer-session",
      },
    }),
  ],
});
```

The secret is held to the fields the configuration names and to nothing else. Each named field
must be there unless it is optional, and must be a non-empty string that can be sent exactly as
stored, so it may contain no control character other than tab and no leading or trailing space or
tab, which the `Headers` class would strip. A field no part names is never read, so an upstream's
secret may hold what it likes. Diagnostics name the field and the rule, never a value.

`sigV4` is for an upstream behind IAM authorisation, such as an API Gateway stage. Its `service`
must be `"execute-api"`: signing is not one algorithm with a service name in it, and S3, say,
wants the hash of the body in a header and its path left unnormalised, neither of which this
does. Another service is added by implementing what it needs, so one that is only named is
refused where the authentication is built. `region` is the upstream's and part of what is signed,
written in the configuration or read from the secret where the upstream keeps it there.

It signs as a role the upstream's owner grants the gateway's account. The gateway assumes the role
through STS with its own credentials, passing the external ID where the role's trust policy asks
for one, which guards the role against a caller acting on someone else's behalf, and a session name
that appears in the upstream's audit trail. The credentials STS returns are held until five
minutes before they expire and assumed again then; a secret rotated to another role is assumed on
its next request. The signature covers the method, the address, the headers set before it and a
hash of the body. The signer leaves out the few headers a transport may add or change,
`user-agent`, `expect` and any `proxy-` or `sec-` header, which are sent unsigned. The signer and
the credential providers are the AWS SDK's own, which every gateway already carries to read its
secret.

The hash of the body goes in the signature, not in a header, and `X-Amz-Content-Sha256` is owned
so that nothing can supply one: the signer takes a hash already on a request in place of hashing
the body, so a mapping that sent `UNSIGNED-PAYLOAD` would sign every body alike and the signature
would stop binding what was sent. One that reaches the signer anyway is taken off first. A query
parameter named `__proto__` is refused rather than signed: the signer reads a query through an
ordinary object, where that name is the prototype and not a name, so the request would carry a
parameter the signature did not cover.

A part is data. It declares the headers it owns, the fields it reads and a `create` function that
builds its per-executor state, and nothing in it reads a secret or exchanges a token when the
configuration is imported, so codegen loads a configuration without an environment or AWS access.
No two parts may own a header. A custom flow is one more part, written with `defineAuth`:

```ts
import { defineAuth, fromSecret } from "@repo/gateway-driver-openapi-rest";
import { GatewayError } from "@repo/gateway-runtime";

const CLIENT_ID = fromSecret("clientId");
const CLIENT_SECRET = fromSecret("clientSecret");
const TOKEN_URL = fromSecret("tokenUrl");

export const clientCredentials = defineAuth({
  headers: ["authorization"],
  fields: [CLIENT_ID, CLIENT_SECRET, TOKEN_URL],
  create: ({ secret, transport }) => {
    let token: { value: string; expiresAt: number } | undefined;
    return {
      async headers({ signal }) {
        if (token === undefined || token.expiresAt <= Date.now()) {
          const values = await secret.get();
          const response = await transport.request(
            {
              method: "POST",
              url: values.get(TOKEN_URL) ?? "",
              form: {
                grant_type: "client_credentials",
                client_id: values.get(CLIENT_ID) ?? "",
                client_secret: values.get(CLIENT_SECRET) ?? "",
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

`headers` is given the request it is authenticating as well as the operation's name and the
attempt's signal: the `method`, the `url` it is going to with its query, the `headers` set so far,
the body's content type and the headers of earlier parts among them, and the `body` as it will be
sent. Each is a copy, so what a flow does to one changes nothing that is sent; the headers it
returns are the only thing it adds, and only the ones it declares. A scheme that signs a request
needs all of it; one that attaches a token needs none.

`headers` runs inside every request's attempt, so a secret read or an exchange counts against
the operation's timeout, and a request that runs out of budget stops waiting; a read the
runtime has already started completes on its own and fills the cache. `secret.get` returns the
named fields of the current secret: the runtime reads it through Powertools Parameters, which
serves a retrieved copy for five minutes and reads again on the first call after that. Concurrent
calls on a cold or expired cache may each read; nothing coordinates them. Every named field is
checked on every read; a secret that fails is never returned, and the operation fails instead, as
`INTERNAL`, as it does when a read fails. Rotating the secret therefore needs no restart: a part
sends the new value on the first read after the cache age. Token and session expiry are the
flow's own concern.

`transport.request` is the only way a flow reaches the network. It sends one request with the
signal the flow was given, to an absolute URL or to a path on the target, with a JSON or a form
body, applies the response limit and returns the raw status, headers and body. It takes the same
transport rule as the target: https, or http only for a loopback host, since a token exchange
carries the credentials that obtain the credential. Statuses are not mapped, since what a token
endpoint's answer means is the flow's decision. `sigV4`'s role assumption is the one exception to
this transport: it goes to STS through the AWS SDK, as the secret itself is read. A flow's own
`GatewayError` is reported as it is; any other error it raises is replaced with an `INTERNAL`
diagnostic that names the operation only.

When the upstream refuses a request's credentials, with a 401 or a 403, the secret may have been
rotated since it was cached: DVLA's rotation, for one, invalidates the old password and key the
moment it runs. The driver then reads the secret again from the store, bypassing the cache and
refreshing it, and calls each part's `refused()`, where a part drops what it holds, a token or an
assumed role's credentials, so the next request authenticates afresh. A GET is sent once more,
inside the same attempt, so the policy timeout bounds both requests, and only the second answer is
mapped to an outcome or an error and counted towards upstream health: the refusal it answered is
not. A second refusal is the answer, as `UPSTREAM_REJECTED`. Any other method is not sent again,
and its refusal is the answer: a 401 or a 403 does not show that the upstream refused before it
acted, since API Gateway passes on whatever status the service behind it chose, and that service
may have done the work first. A gateway whose `auth` is `[]` does none of this, since a refusal
there is not about a credential. The driver logs each refusal, with its status and whether the
request was sent again.

### Custom handlers

An operation with a `handler` bypasses the automatic mapping. A handler is a value produced by
the driver's `defineHandler`, set on the operation in the configuration; where it is written
is up to the author, with a module next to the configuration being the usual choice. The
compiler checks it against the driver's handler type, which the definition exposes through
`HandlerOf`. That type is branded with the driver's `type`, and only `defineHandler` produces
it, so a plain function or a handler written for another driver is a type error on that line.
`defineHandler` also lets the author name the input type. Both paths use the same client, so every upstream call still goes
through `ctx.upstream` once and maps transport errors the same way.

A handler for an identity lookup might turn the upstream's 404 into an `unlinked` outcome, which
the operation's schemas then declare alongside `ok`:

```ts
import { defineHandler } from "@repo/gateway-driver-openapi-rest";

interface IdentityExchangeInput {
  requiredService: string;
  requestingService: string;
  requestingServiceUserId: string;
}

export default defineHandler(async (input: IdentityExchangeInput, client) => {
  const response = await client.request(client.prepare(input));
  if (response.status === 404) {
    return { outcome: "unlinked", data: null };
  }
  return client.mapResponse(response);
});
```

The input annotation states what the operation's input schema describes, and the outcomes the
handler returns are inferred. Both stay on the handler's type, so calling it with the wrong
input is a type error and a generated contract can check them against the schemas. An operation
with no schemas, or schemas for an operation the configuration does not declare, fails code
generation; see [what codegen checks](#what-codegen-checks).

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

Either may also carry `meta`: what the gateway reports about an exchange beside its result, such
as an upstream's own id for the request, which is what its support asks for. A gateway's schemas
declare each name under `meta` with the schema of one scalar, a string, a number, an integer or
a boolean, never an object or a list. A driver reports a value through its context,
`ctx.meta(name, value)`, rather than in its result, because a driver that fails throws, and what
it learnt before it threw is what a caller most needs. The runtime keeps only the names the
gateway declared, validates each against its schema, returns what passes on a failure as on a
success, and writes it to that call's log line. What fails is left out and logged as the schema
location that refused it, never as its value, and nothing reported can fail a call. Every part
of `meta` is optional to a caller, and so is the whole: a request refused before it reached the
upstream, or one whose response never arrived, has nothing to report. One that timed out still
reports what the driver recorded before it did. It is not a second channel for
diagnostics; only declared, validated scalars travel in it. Between
[versions](#compatibility-between-versions) a name may be added or removed, since every name is
optional and a caller already handles one being absent; a caller that upgrades past a removal
has a branch to delete. A name that stays is compared the way an outcome's data is, since both
run from the upstream to the caller, so a wider type breaks a caller and a narrower one does not.

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
  runtime applies the timeout and passes an abort signal to `fn`. A driver logs through
  `ctx.log.info` and `ctx.log.warn`: its own message and scalar fields, which the runtime writes
  under `driver` beside the operation, and never a credential, a payload value or an upstream's
  text.
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
