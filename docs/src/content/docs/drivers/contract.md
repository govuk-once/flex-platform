---
title: The driver contract
description: What a driver definition contains, what the runtime gives an executor, and what the executor must return.
---

A driver owns one transport. It is the only code that uses that transport's vocabulary. For HTTP,
that means methods, paths, status codes and headers. A driver turns a validated input into upstream
calls, and turns the upstream's answer into a named outcome.

The runtime and the generator know nothing about a driver except the contract on this page. The
contract lives in `@repo/gateway-config` (the definition) and `@repo/gateway-types` (the execution
types).

## The driver definition

A gateway configuration sets `driver` to a value its driver package builds, such as
`openapiRest({ … })`. That value is a `DriverDefinition`:

```ts
interface DriverDefinition<TOpFields, THandler> {
  readonly type: string;
  createExecutor(config: GatewayConfig, options: ExecutorOptions): Promise<ExecuteFn>;
  checkSchemas?(config: GatewayConfig, schemas: GatewaySchemas): readonly string[];
  readonly deriveSchemasModule: string;
}
```

Anything else a driver needs from the configuration, such as a document location, headers or
authentication, is set on the same object beside these members. It is reviewed there with the
gateway.

### `type`

A literal string naming the driver, such as `"openapi-rest"`. It brands the driver's handlers and
keys its operation refinements, so it must be unique across drivers.

### `TOpFields`

The fields the driver adds to every operation, such as openapi-rest's `upstream` and
`parameters`. `defineGateway` intersects them with the fields every operation has (`description`,
`log`, `secure` and `handler`), and a misspelt key is a type error.

### `createExecutor`

The [generated entry point](/flex-platform/codegen/entry-point/) calls it once, when the gateway
starts, as `config.driver.createExecutor(config, options)`. Because the definition carries it, the
entry point and codegen reach every driver in the same way. Nothing outside a configuration names a
driver package.

It is asynchronous so that anything that can fail does so before the executor exists. It must:

1. Check the driver's configuration, and compile every operation.
2. Retrieve the secret through `options.secret` and validate the fields the configuration names.
3. Build authentication state on it.
4. Resolve to the execute function.

So a missing or invalid secret on the initial read stops the gateway from starting. A later read
can still fail, for example after rotation, and then fails the affected call.

The definition's module imports the runtime half of the driver **dynamically**, inside
`createExecutor`. This lets codegen evaluate a configuration without loading the runtime half:

```ts
createExecutor: (config: MyGatewayConfig, options: ExecutorOptions) =>
  import("../runtime/executor.ts").then((m) => m.createExecutor(config, options)),
```

The `config` parameter can use the driver's own configuration type. TypeScript allows this for
method parameters.

### `ExecutorOptions`

The options the entry point passes. `readUpstreamOptions` reads them from the environment. None
of them names a transport or says what the secret holds.

| Option | Purpose |
|---|---|
| `target` | `UPSTREAM_TARGET`, if the deployment sets it. The driver decides what it means. A driver may take the location from a field of the secret instead. It refuses to start if it has neither. |
| `secret` | A `SecretProvider` for the secret `UPSTREAM_SECRET_ARN` names. `get()` returns the parsed JSON object, cached for a bounded age; `get({ fresh: true })` bypasses the cache. |
| `log` | Where the driver logs while its executor is created. Optional. |

### `checkSchemas`

Optional. Codegen calls it with the configuration and the latest schemas before it writes
anything. It returns every problem it finds as a message, and the run fails if it returns any.

This is where a driver relates its operation fields to the schemas, for example a path template to
the input fields that fill it. A mismatch then fails generation, not a request in production.
Keeping these checks in the driver keeps transport vocabulary out of the generator.

A driver needs one whenever its operation fields refer to fields of the schemas, or its transport
limits what a schema may declare. A driver whose operation fields say nothing about the schemas
can leave it out. The [driver tutorial](/flex-platform/drivers/writing-a-driver/#4-the-build-time-check)
has a complete example.

### `deriveSchemasModule`

Required. A `file:` URL to the module that derives a gateway's schemas. No version is written by
hand. A driver derives from the upstream's own description where it publishes one, such as an
OpenAPI document. Where it publishes none, as with a DynamoDB table, the driver derives from
schemas the configuration declares. A driver can also do both, as openapi-rest's `narrow` does for
what a document leaves open. Build the URL from the driver's module URL:

```ts
const DERIVE_MODULE = new URL("../derive/index.ts", import.meta.url).href;
```

It must be a URL, never an import. The entry point imports the configuration, and the bundler
follows every import it can see from there, including dynamic imports. An import would put the code
that parses the upstream's description into the deployed gateway. A driver that only reads its
configuration has no parser to keep out, but gives a URL all the same.

`gateway-schemas` loads the module to write a version. Codegen loads it too, with the network
refused, to check that the latest version is still what the driver derives. See
[What codegen checks](/flex-platform/codegen/checks/#what-the-driver-derives). Nothing bundles it.
Its default export is a `DeriveSchemas`:

```ts
type DeriveSchemas = (config: GatewayConfig, sources: SchemaSources) => Promise<DerivedSchemas>;

interface SchemaSources {
  // An https URL, or a path within the gateway's directory.
  load(location: string): Promise<string>;
}

interface DerivedSchemas {
  readonly schemas: GatewaySchemas;
  // Where deriving departed from what the upstream wrote, for whoever reviews the result.
  readonly notes: readonly string[];
}
```

Deriving reaches the network only through `sources.load`. It fetches over https, does not follow
redirects and stops at 16 MiB. A driver that derives from its configuration does not call it.

## The execute function

```ts
type ExecuteFn = (ctx: DriverContext, operation: string, input: unknown) => Promise<OperationResult>;

interface OperationResult<TOutcome extends string = string> {
  readonly outcome: TOutcome;
  readonly data: unknown;
}
```

By the time it is called:

- the operation has matched a configured operation;
- `input` has passed the operation's input validator and its secure bindings;
- the deadline is set.

The result it returns is validated against the schema for the outcome it names. An outcome the
schemas do not declare is `UPSTREAM_CONTRACT_VIOLATION`.

### `DriverContext`

```ts
interface DriverContext {
  readonly log: DriverLogger;
  upstream<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
  meta(name: string, value: unknown): void;
}
```

| Member | Use |
|---|---|
| `upstream(fn)` | Make each upstream call through this, once per call. The runtime limits the attempt by the policy timeout and the request's remaining time budget. It passes a fresh abort signal, and reports an attempt that runs out of time or is aborted as `UPSTREAM_TIMEOUT`. |
| `meta(name, value)` | Report something about the exchange beside its result, such as an upstream request id. It is kept only if the gateway's schemas declare the name, and it is validated. Nothing reported can fail a call. Report it as soon as it is known: if the driver then fails, the value is still returned. |
| `log.info`, `log.warn` | A message and scalar fields of the driver's own, written under `driver` beside the matched operation. |

### Failures

Throw a `GatewayError` from `@repo/gateway-runtime` with a code and a message that is safe to
log:

```ts
throw new GatewayError("UPSTREAM_ERROR", `Operation "${operation}": upstream returned a server error`);
```

The runtime logs a `GatewayError`'s message as written and returns its code. Any other error is
logged only as its source locations, and returned as `INTERNAL`. So a driver raises its own
request-time failures as `GatewayError` to keep the diagnosis, with `INTERNAL` for configuration
bugs. See [error codes](/flex-platform/gateways/responses/#error-codes) for what each code means
and how it counts towards upstream health.

## Custom handlers

A driver may let an operation replace its automatic behaviour with a handler. The handler type
is a `BrandedHandler` that carries the driver's `type`. Only the driver's `defineHandler` produces
one. So a plain function, or a handler written for another driver, is a type error where it is
set:

```ts
export type MyHandler<TInput = never, TOutcome extends string = string> = BrandedHandler<
  typeof MY_DRIVER_TYPE,
  (input: TInput, client: MyClient) => Promise<OperationResult<TOutcome>>
>;

export function defineHandler<TInput, TOutcome extends string>(
  fn: (input: TInput, client: MyClient) => Promise<OperationResult<TOutcome>>,
): MyHandler<TInput, TOutcome> {
  return fn as unknown as MyHandler<TInput, TOutcome>;
}
```

The brand exists only at the type level. The driver declares the handler type as the second type
parameter of its definition, and `HandlerOf<D>` reads it back. The driver's executor dispatches to
`config.operations[name].handler` when one is set. Anything the handler is given for reaching the
upstream must still make each call through `ctx.upstream`.

## Operation refinements

Some checks relate one operation field to another at the type level, for example a path template
to the parameters that fill it. A driver registers such a check by augmenting
`OperationRefinements`, keyed by the driver's literal `type`. `defineGateway` applies it to each
operation as written:

```ts
declare module "@repo/gateway-config" {
  interface OperationRefinements<TOp> {
    readonly "openapi-rest": RefineOpenApiRestOperation<TOp>;
  }
}
```

The member receives the operation and returns the type the operation must be assignable to. The
config package holds only the slot and no driver vocabulary. Import the module that declares the
augmentation from the driver's `index.ts`, so every consumer of the package has it.
