---
title: Design constraints
description: The boundaries where a violation goes unnoticed, and the reasoning behind each.
---

Breaking one of these is silent. The build stays green and the tests pass, but the behaviour is
wrong somewhere else. That is why they are listed instead of left to judgement. Keep them true
when you extend the code, and treat them as boundaries, not a list of work to do. A requirement
for an integration does not mean that integration is implemented.

1. **Transport-neutral contracts.** The runtime and codegen share JSON Schema and opaque driver
   definitions. Upstream methods, paths, status codes and headers belong in transport adapters.
   Adding a transport should not need transport-specific logic in the dispatcher or generator.
   - `gateways/drivers/openapi-rest` is the only package that names methods, paths, status codes
     or headers. Callers see outcome names such as `ok` and `no_content`, never a status.
   - Every driver derives its gateways' schemas, from the upstream's own description or from
     schemas the configuration declares, so no version is written by hand. It gives the deriving
     module as `deriveSchemasModule`, a `file:` URL built from its own module, and never imports
     it. The entry point imports the configuration, and the bundler follows every import from
     there, so an import would put the upstream description parser into the deployed gateway.
     `gateway-schemas` loads it to write a version, and codegen loads it with the network refused
     to check the latest version is still what it derives. Nothing bundles it.
   - Output from either command (a report, or the error that stopped it) contains upstream text.
     It goes out through `printable`, which writes any character that does not display as its code
     point.
   - A driver definition carries its own `createExecutor`. Codegen and a generated entry point
     reach any driver the same way, as `config.driver`, and pass it the neutral
     `ExecutorOptions`. Nothing outside a configuration names a driver package.
   - A driver's handler type is a `BrandedHandler` carrying its `type`, and only that driver's
     `defineHandler` produces one. A configuration imports its handlers statically and sets them
     on operations, so a handler cannot be wired to the wrong driver.
   - If an entry point would need to know about a specific driver or gateway, that is a design
     error.

   See [the driver contract](/flex-platform/drivers/contract/).

2. **Upstream calls use the driver context.** Make each upstream call with `ctx.upstream(fn)`,
   once per call.
   - The runtime calls `fn` once per attempt, so `fn` must build its request each time and must
     not retry internally. A driver never expresses retry behaviour, so it cannot get it wrong.
   - The one exception: after the upstream refuses the gateway's credentials, a GET is sent once
     more, inside the same attempt, with the secret read again (constraint 12).
   - Each attempt passes a fresh abort signal, which the driver should wire into its transport.
     The runtime bounds the whole of `fn` either way, so a driver that ignores the signal still
     behaves correctly, but it leaks the connection.
   - Separate calls are separate `upstream` invocations and share no attempt state, so parallel
     calls cannot use up each other's allowance.
   - Convert transport errors to `GatewayError` with controlled diagnostic messages. Library
     errors can contain payload data.

   See [the driver context](/flex-platform/drivers/contract/#drivercontext) and
   [writing a driver](/flex-platform/drivers/writing-a-driver/).

3. **Validate before dispatch and before returning data.** Keep the handler's order: envelope
   parsing, token verification hook, routing, input validation, secure bindings, deadline
   derivation, execution, outcome validation, health classification and response. The token hook
   currently performs no verification.
   - Invalid configuration should fail when the handler is created, not per request. The handler
     compiles once and takes each invocation's deadline as an argument. Nothing specific to one
     invocation is captured at creation.
   - A driver's `createExecutor` is asynchronous for the same reason. Before it resolves, it
     retrieves the gateway secret through the provider in its options, validates it, and builds
     its authentication state. A missing or invalid secret fails at startup, never on the first
     request.
   - Look up outcome validators in a `Map`, never a plain object. The outcome name comes from the
     driver at request time, and an object lookup finds inherited members.
   - A validator reads only the fields an object holds, never inherited ones, for the same
     reason. Every value it sees came from `JSON.parse`, so `Object.prototype` is behind it. A
     schema naming `constructor`, `toString` or any other prototype member would otherwise be
     answered by the prototype. Ask Ajv for own properties explicitly wherever a schema is
     read. Refusing `__proto__` does not cover this: these names belong to the prototype itself,
     so no schema has to mention them for a caller to be held to the values they hold.

   Each step owns an error code:

   | Step | Code |
   |---|---|
   | Envelope parsing, input validation | `INVALID_INPUT` |
   | Routing, for an unknown operation | `OPERATION_NOT_FOUND` |
   | Secure bindings | `SECURE_VALUE_MISMATCH` |
   | Outcome validation | `UPSTREAM_CONTRACT_VIOLATION` |
   | Anything uncaught | `INTERNAL` |

   Execution passes on any `GatewayError` the driver raises. The runtime itself only adds
   `UPSTREAM_TIMEOUT` at that step. Input validation runs before any upstream call, so an invalid
   request never reaches the upstream. Nothing throws out of the handler: every failure leaves as
   an envelope.

   See [a request](/flex-platform/gateways/overview/#a-request).

4. **Errors carry codes.** Failure responses are `{ ok: false, error: { code } }`. Diagnostic
   messages stay in logs and must be safe to log.
   - A `GatewayError` declares that its message is safe, and the runtime records it as written.
   - Any other error is logged as its source locations and the dispatcher step only. A library or
     a custom handler can put a payload in the message, the name, the properties, the cause or the
     stack text, and the stack text can be overwritten.
   - The locations come from V8's structured frames, through a temporary `Error.prepareStackTrace`
     hook, as file, line and column only. They are never read from the stack string. A stack that
     was already formatted or replaced gives no locations. Summarising an error must never throw.
   - Source filenames are trusted deployment metadata. Eval frames are skipped, but that does not
     cover every way code can be loaded under a name taken from a payload. The protection covers
     what an error says, not where code chose to load itself from.
   - So drivers raise their own request-time failures as `GatewayError`, using `INTERNAL` for
     configuration bugs, so the diagnosis is kept.

   Success responses are `{ ok: true, outcome, data }`, which keeps the outcome separate from
   upstream fields. Either response may carry `meta`: what the gateway declares it reports
   alongside a result, such as an upstream's id for a request. `meta` is not a way around this
   rule:
   - it holds only names the schemas declare, each a scalar validated against its schema, and never
     a message;
   - a driver reports through `ctx.meta`, because a driver that fails throws;
   - the runtime leaves out anything that fails validation, logs where it failed but not the value,
     and never lets a reported value fail a call, including on the unhandled error path;
   - every part of it is optional to a caller;
   - a driver names each value neutrally, so a caller never sees the header, or other source, it
     came from.

   See [responses and errors](/flex-platform/gateways/responses/).

5. **Error codes declare health semantics.** Every code in `ERROR_CODES` has a signal ruling.
   `NOT_FOUND` and `UPSTREAM_REJECTED` represent an upstream response. Contract violations and
   timeouts represent failures. Gateway-side rate limits and breaker rejections must stay neutral
   to upstream health, so a control's own output is not fed back into it. The runtime currently
   logs these classifications and does not operate a breaker. An upstream 429 also maps to
   `RATE_LIMITED` and keeps that neutral ruling. The gateway's own limit should sit below any
   upstream threshold, so reaching an upstream limit is a gateway configuration problem.

   See [health rulings](/flex-platform/gateways/responses/#health-rulings).

6. **Payload logging is explicit and leaf-only.** Select fields with `log.input` and `log.output`.
   Paths that resolve to objects or arrays are dropped, so new nested fields are not logged
   automatically. Keep tests that check unselected fields and synthetic secrets are absent from
   captured payload logs.
   - Review diagnostic messages separately. A validation failure is logged as the schema locations
     that rejected it, never as an instance path, because a dictionary schema takes the path's
     segments from the caller's own keys.
   - The operation name also comes from the caller. Log it, in a message or as a field, only once
     it matches a configured operation. Leave an unknown one out instead of repeating it.
   - A driver logs through `ctx.log`: its own message and scalar fields, which the runtime keeps
     under `driver`, next to the matched operation. Review driver code like the runtime's. Its log
     lines follow the same rule: never a credential, a payload value, or text a caller or an
     upstream wrote.

   See [logging](/flex-platform/gateways/configuration/#logging).

7. **Preserve contract compatibility.** Changes to an established gateway contract must be
   additive. An incompatible contract needs a distinct gateway identity.
   - The exception is `meta`. A name may be removed as well as added, because every part of `meta`
     is optional to a caller. A name that stays follows the rules for an outcome's data.
   - Codegen enforces this for the schemas by comparing each version in a gateway's `schemas/` with
     every one before it, not only its neighbour, because removing a `meta` name and adding it back
     is safe at each step. CI refuses a change to a merged version, because that would change what
     the others are held to. The `schema-history-override` label is a rarely used escape hatch for
     a version that was never deployed. See
     [Schemas and versions](/flex-platform/gateways/schemas/).
   - Keep three things true of the comparison: anything it cannot place counts as a break,
     `oneOf` is not read as a union, and a definition is checked on each side of the call where it
     is used.
   - The comparison does not cover the types the generator emits for an unchanged schema, or the
     error codes. A change to either still needs this rule applied by hand.

   The rules are in [the compatibility guide](/flex-platform/gateways/compatibility/).

8. **Avoid duplicate upstream writes.** Any invocation client must turn off automatic SDK retries
   (`maxAttempts: 1`). A retry decision needs to know the operation and the deadline. Transport
   retries alone do not, and neither would an attempt count in the policy, which is why there is
   none. Nothing retries a call today. The single replay after a refused credential is for a GET
   only. A 401 or a 403 does not show that the upstream refused before acting, because Amazon API
   Gateway passes on whatever status the service behind it chose. So a write that is refused is
   never sent again.

   See [refused credentials](/flex-platform/drivers/openapi-rest/authentication/#when-the-upstream-refuses-a-credential)
   and [calling gateways](/flex-platform/domains/overview/#calling-gateways).

9. **Emitted validators are self-contained JavaScript.** Bundle Ajv's runtime helpers and formats
   at generation time, resolving them from codegen's dependencies. Do not keep a manual list of
   helpers.
   - Validator output has no package imports or declaration files. This rule is for validators,
     not every generated artifact. The entry point and the call contract do import packages.
   - The entry point is JavaScript for the same reason the validators have no declaration files:
     a TypeScript module could not import them.
   - Keep the subprocess tests that run outside workspace dependency resolution, and the fixtures
     that exercise runtime helpers.
   - Generated code is not typechecked, and nothing outside `.gen/` imports it. So a codegen test
     checks the generated contract by compiling it.

   See [validators](/flex-platform/codegen/overview/#validators).

10. **Keep shared types independent of execution.** `@repo/gateway-types` has no package
    dependencies, so consumers can name envelopes and error codes without installing the runtime
    or generator. Parsing and `GatewayError` belong in the runtime.
    - Import a shared type from the package that declares it. No package re-exports another's
      types, and every package that uses one declares the dependency itself.
    - Keep literal operation names in `defineGateway` types.
    - A driver that needs a check relating one operation field to another registers it by
      augmenting `OperationRefinements`, keyed by its literal `type`. The config package holds only
      that slot and no driver vocabulary.

    See [packages](/flex-platform/reference/packages/).

11. **Keep configuration environment-independent.** Do not hard-code deployed addresses,
    credentials or environment names in gateway code. Deployment-specific configuration belongs at
    the integration boundary.
    - Every driver takes its secret from the AWS Secrets Manager secret whose ARN is in
      `UPSTREAM_SECRET_ARN`. It is required, even for a gateway that sends no credential.
    - A driver takes its upstream location from `UPSTREAM_TARGET` when that is set. The runtime
      names both variables.
    - A secret may be the gateway's own, or one an upstream provides in its own shape. So a driver
      may also take the location from a field of the secret that its configuration names. That
      field is used in place of `UPSTREAM_TARGET` when both are there. A driver with neither
      refuses to start.
    - The driver decides what the target means and which secret fields are read, and declares both
      on its definition. The runtime only retrieves the secret as a JSON object and caches it for a
      bounded age.
    - Read the variables at the entry point through `readUpstreamOptions`, which builds the secret
      provider, and pass the result in. Never read them inside a request.
    - A gateway configuration never names an ARN or a secret value, and importing one never
      reaches the environment or AWS.

    See [environment](/flex-platform/reference/environment/).

12. **Secrets are validated before use and authentication is driver-owned.**
    - The runtime reads the secret through Powertools Parameters as a JSON object. It serves it from
      the cache for a bounded age, then reads it again. Concurrent reads on an expired cache may
      each reach the store. A read that a caller stopped waiting for still completes on its own.
      The runtime knows nothing about the fields.
    - A driver reads only the fields its configuration names, each with `fromSecret`, and none by
      default. It checks every one on the first read and every read after, before any value
      reaches authentication code, and ignores the rest. An invalid secret is never returned, and
      the affected operation fails.
    - Diagnostics about a secret name the field and the rule it broke. They never include a value,
      or a field the configuration did not name. A failed read is reported as a fixed message with
      nothing from the library's error. An optional field the secret does not hold is logged by
      name as the gateway starts.
    - A gateway's authentication is a list of parts. Each part is shown the headers the parts
      before it set. A part declares the headers it owns and the fields it reads. The driver
      reserves the owned headers before compiling operations, so no static header, mapping,
      handler or other part can set them. A part may set no other header.
    - A part is shown a copy of the request it is authenticating: method, address, headers and
      body. This is because a scheme such as `sigV4` signs the request instead of attaching a
      credential. Nothing the part does to the copy is sent.
    - `sigV4` signs as a role the secret names, assumed through STS with the gateway's own
      credentials.
    - A part's state is built per executor, and its network access goes through the driver's
      transport. Nothing in a configuration module reads a secret or exchanges a token at import.
      Assuming a role is the one exception to the transport: it goes to STS through the AWS SDK,
      the same way the secret is read.
    - Token and session expiry are the part's responsibility.
    - When the upstream refuses the gateway's credentials with a 401 or a 403, the driver reads the
      secret again from the store, not the cache, because a rotation replaces credentials faster
      than the cache expires. It has every part drop what it holds. A GET is then sent once more,
      inside the same attempt, and only the second answer is mapped and counted. Any other method
      is not sent again (constraint 8), and its refusal stays the result even if that read fails.
      This applies only to a gateway that sends a credential.

    See [authentication](/flex-platform/drivers/openapi-rest/authentication/).

13. **Schema text is data, wherever it is written.** A version's descriptions can come from an
    upstream's own document, and the call contract writes them into code a caller compiles.
    - `docComment` is the only way text becomes a comment. It stops `*/` from ending the comment.
      It writes every `@` as a character reference, so no text can open a JSDoc tag anywhere. It
      writes every line of the text inside one block comment, and the block starts on a line of its
      own, because the compiler attaches nothing to a comment that shares a line with the token
      before it.
    - Every tag in the contract is one the generator wrote from what a schema declares.
    - Escaping an `@`, instead of replacing it, is not enough. `stripInternal` reads the comment
      text, and would remove a declaration while code that refers to it stays.
    - Names and values reach generated code through `JSON.stringify` or `assertIdentifier`, never
      by interpolation.
    - Characters that do not display are refused when a version is read, in names and values
      alike, checked on the parsed value. This way a reviewer sees what the file holds.
    - Keep the tests that compile a contract built from hostile text, the tests that emit
      declarations from it with `stripInternal` on, and the tests that prove both can see a tag
      at all.

    See [the call contract's comments](/flex-platform/codegen/call-contract/#comments).

14. **Inputs are held to everything, outcomes to their shape.** When deriving:
    - for an input, it closes every object that names its fields and says nothing about the rest,
      and keeps every constraint and `enum` exactly;
    - for an outcome, it opens closed objects, drops bounds, `pattern` and `format`, and turns an
      `enum` into the known values alongside their type.

    The reason is the direction each side can change without breaking a caller. An input can be
    loosened later but never tightened. An upstream adds fields, values and length to what it sends
    without asking. Making an outcome stricter turns a minor upstream release into failed responses
    in production. Making an input looser cannot be undone.

    An object that names no field is an object of any shape. Closed, it would admit only `{}`. So
    it stays open, and the contract types it as an object of any shape, until an operation's
    `narrow` states its shape. Otherwise the contract's types stay closed, so they never suggest
    fields that a caller's version does not declare.

    See [deriving schemas](/flex-platform/drivers/openapi-rest/deriving-schemas/#inputs-and-outcomes-are-converted-differently).

15. **No caller chooses an upstream path.** A path parameter is one segment, and the driver refuses
    a value containing a "/".
    - A template that takes the rest of a path, `{name+}`, is reached only by an operation that
      writes its path out in full and names the template in `matches`. Otherwise, deriving fails
      for a path the document does not have.
    - Deriving also refuses a path that a more specific template would be routed to, and a path a
      router could read as a different one: one with an empty segment, or with a slash or backslash
      written inside a segment.
    - If a caller could fill a parameter with several segments, one operation could reach every
      other operation's endpoint, bypassing its input schema, its `secure` bindings and its logging.
    - What such a template leaves unsaid, the operation states with `narrow`. It replaces an object
      of any shape, and is merged into anything the document does describe, where it can only make
      a schema admit less.

    See [paths the document does not declare](/flex-platform/drivers/openapi-rest/deriving-schemas/#paths-the-document-does-not-declare).
