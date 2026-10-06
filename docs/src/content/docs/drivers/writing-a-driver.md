---
title: Writing a driver
description: "Add a transport: the package layout, the definition, the executor, and the rules a driver must keep."
---

You need a new driver when no existing driver can reach an upstream. For example, the upstream
uses a different protocol, or it is an AWS service called through its SDK.

This page builds a small but complete driver, `json-rpc`, for a JSON-RPC 2.0 upstream over HTTPS.
It ends with the rules every driver must keep. Read
[The driver contract](/flex-platform/drivers/contract/) alongside it.

The example is not a package in the repository. Its code is typechecked against the workspace's
packages. It leaves out some things a production driver needs, and the page names them as it
goes.

## Package layout

A driver is a package under `gateways/drivers/`, split by when its code runs:

```txt
gateways/drivers/json-rpc/
  package.json
  tsconfig.json
  eslint.config.ts
  src/
    index.ts          what a configuration imports
    types.ts          vocabulary both halves use: the driver type, client and handler types
    config/           evaluated by codegen when it loads a configuration
      definition.ts   the factory a configuration calls, returning the DriverDefinition
      check.ts        checkSchemas, the build-time check against the schemas
      handler.ts      defineHandler
    runtime/          reached only through createExecutor's dynamic import
      executor.ts
    derive/           reached only through deriveSchemasModule
      index.ts        derives the gateway's schemas
```

`config/` must not use the network, a secret or the environment, because codegen evaluates it
without any of them. `runtime/` is loaded when the gateway starts. `derive/` is loaded by
`gateway-schemas`, and by codegen with the network refused, and is never bundled. A lint rule keeps the three apart, as openapi-rest's
does:

```ts title="eslint.config.ts"
import { driver } from "@repo/eslint-config";

const RUNTIME = {
  group: ["**/runtime/**"],
  allowTypeImports: true,
  message: "Only createExecutor reaches the runtime, and it imports it dynamically.",
};

export default [
  ...driver,
  {
    files: ["src/*.ts", "src/config/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [RUNTIME] }],
    },
  },
];
```

```json title="package.json"
{
  "name": "@repo/gateway-driver-json-rpc",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "lint": "eslint src/ test/",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@repo/gateway-config": "workspace:*",
    "@repo/gateway-runtime": "workspace:*",
    "@repo/gateway-types": "workspace:*"
  },
  "devDependencies": {
    "@repo/eslint-config": "workspace:*",
    "@repo/tsconfig": "workspace:*",
    "@repo/vitest-config": "workspace:*",
    "eslint": "10.10.0",
    "vitest": "5.0.1"
  }
}
```

Every package that uses a shared type declares the dependency itself. No package re-exports
another package's types. The package exports its TypeScript source, and nothing is compiled.

## 1. The vocabulary

This file holds the driver's literal `type`, what a custom handler is given, and the branded
handler type:

```ts title="src/types.ts"
import type { BrandedHandler } from "@repo/gateway-config";
import type { OperationResult } from "@repo/gateway-types";

export const JSON_RPC_DRIVER_TYPE = "json-rpc";

// What a custom handler is given to reach the upstream. Each call is one ctx.upstream attempt.
export interface JsonRpcClient {
  call(method: string, params: unknown): Promise<unknown>;
}

// Branded with this driver's type, so a handler written for another driver is a type error.
export type JsonRpcHandler<
  TInput = never,
  TOutcome extends string = string,
> = BrandedHandler<
  typeof JSON_RPC_DRIVER_TYPE,
  (input: TInput, client: JsonRpcClient) => Promise<OperationResult<TOutcome>>
>;
```

## 2. The definition

This is the factory a configuration calls. It returns the `DriverDefinition` with the driver's
own settings beside it. `JsonRpcOperationFields` becomes part of every operation's type. So
`defineGateway` rejects an operation that has no `method`, `input` or `outcomes`, or has a misspelt
field.

The upstream publishes no description of its methods, so each operation declares its schemas
itself, and the driver derives the gateway's schemas from them.

```ts title="src/config/definition.ts"
import type {
  AnyOperations,
  DriverDefinition,
  ExecutorOptions,
  GatewayConfig,
} from "@repo/gateway-config";
import type { JSONSchema } from "@repo/gateway-types";

import { JSON_RPC_DRIVER_TYPE, type JsonRpcHandler } from "../types.ts";
import { checkOperationSchemas } from "./check.ts";

// A URL, never an import, so the bundler never follows it into the deployed gateway.
const DERIVE_MODULE = new URL("../derive/index.ts", import.meta.url).href;

export interface JsonRpcDriverConfig {
  // The field of the gateway's secret that holds the bearer token. Named, never defaulted.
  readonly tokenField: string;
}

// What every operation adds: the remote method it calls, and what that method takes and answers.
export type JsonRpcOperationFields = {
  readonly method: string;
  readonly input: JSONSchema;
  readonly outcomes: Readonly<Record<string, JSONSchema>>;
};

export interface JsonRpcDriver
  extends
    DriverDefinition<JsonRpcOperationFields, JsonRpcHandler>,
    JsonRpcDriverConfig {
  readonly type: typeof JSON_RPC_DRIVER_TYPE;
}

export type JsonRpcGatewayConfig = GatewayConfig<
  JsonRpcDriver,
  AnyOperations<JsonRpcDriver>
>;

export function jsonRpc(settings: JsonRpcDriverConfig): JsonRpcDriver {
  return {
    type: JSON_RPC_DRIVER_TYPE,
    // Loaded on first call, so codegen evaluates the configuration without the runtime.
    createExecutor: (config: JsonRpcGatewayConfig, options: ExecutorOptions) =>
      import("../runtime/executor.ts").then((m) =>
        m.createExecutor(config, options),
      ),
    checkSchemas: checkOperationSchemas,
    deriveSchemasModule: DERIVE_MODULE,
    tokenField: settings.tokenField,
  };
}
```

The configuration names the secret field that holds the token, and never holds the value
itself. This is because a secret may be the gateway's own, or one an upstream provides in a shape
of its own.

## 3. Deriving the schemas

`gateway-schemas` loads this module and writes what it returns as the gateway's next version,
once the shape has changed and no caller would break. Here the configuration is the description,
so deriving copies each operation's declared schemas, in the order they are written:

```ts title="src/derive/index.ts"
import type { DeriveSchemas } from "@repo/gateway-config";
import type { OperationSchemas } from "@repo/gateway-types";

import type { JsonRpcGatewayConfig } from "../config/definition.ts";

const derive: DeriveSchemas = (config) => {
  const { operations } = config as unknown as JsonRpcGatewayConfig;
  const derived: Record<string, OperationSchemas> = {};
  for (const [name, op] of Object.entries(operations)) {
    derived[name] = { input: op.input, outcomes: op.outcomes };
  }
  return Promise.resolve({ schemas: { operations: derived }, notes: [] });
};

export default derive;
```

A driver whose upstream does publish a description reads it through `sources.load` instead, as
[openapi-rest does](/flex-platform/drivers/openapi-rest/deriving-schemas/). It can still take
from the configuration what the description leaves out.

## 4. The build-time check

`checkSchemas` checks the configuration against the schemas in ways only this driver
understands. It returns every problem, so codegen can report them all together:

```ts title="src/config/check.ts"
import type {
  AnyOperations,
  DriverDefinition,
  GatewayConfig,
} from "@repo/gateway-config";
import type { GatewaySchemas } from "@repo/gateway-types";

// The input is sent whole as the call's params, and the automatic mapping answers `ok` and
// nothing else. An operation with a handler decides its own outcomes.
export function checkOperationSchemas(
  config: GatewayConfig<DriverDefinition, AnyOperations<DriverDefinition>>,
  schemas: GatewaySchemas,
): readonly string[] {
  const problems: string[] = [];
  for (const [name, op] of Object.entries(schemas.operations)) {
    if (op.input.type !== "object") {
      problems.push(`operation "${name}": input must be an object`);
    }
    const handled = config.operations[name]?.handler !== undefined;
    const outcomes = Object.keys(op.outcomes);
    if (!handled && (outcomes.length !== 1 || outcomes[0] !== "ok")) {
      problems.push(`operation "${name}": declare the one outcome "ok"`);
    }
  }
  return problems;
}
```

It does not need to compare the declared schemas with the committed version. Codegen derives
them itself, without the network, and fails if `pnpm schemas` would write a new version. See
[What codegen checks](/flex-platform/codegen/checks/#what-the-driver-derives).

## 5. Custom handlers

```ts title="src/config/handler.ts"
import type { OperationResult } from "@repo/gateway-types";

import type { JsonRpcClient, JsonRpcHandler } from "../types.ts";

// The brand is type-level only; the function is returned unchanged.
export function defineHandler<TInput, TOutcome extends string>(
  fn: (
    input: TInput,
    client: JsonRpcClient,
  ) => Promise<OperationResult<TOutcome>>,
): JsonRpcHandler<TInput, TOutcome> {
  return fn as unknown as JsonRpcHandler<TInput, TOutcome>;
}
```

## 6. The executor

`createExecutor` checks the configuration, then retrieves and checks the secret, before it
resolves. The execute function it returns:

- makes each upstream call through `ctx.upstream`, and builds the request inside it;
- converts every failure to a `GatewayError` with a message that is safe to log;
- reports the upstream's request id through `ctx.meta` before anything can fail.

```ts title="src/runtime/executor.ts"
import type { ExecutorOptions } from "@repo/gateway-config";
import { GatewayError } from "@repo/gateway-runtime";
import type {
  DriverContext,
  ExecuteFn,
  SecretProvider,
} from "@repo/gateway-types";

import type { JsonRpcGatewayConfig } from "../config/definition.ts";
import type { JsonRpcClient } from "../types.ts";

type TokenReader = (options?: { fresh: boolean }) => Promise<string>;

export async function createExecutor(
  config: JsonRpcGatewayConfig,
  options: ExecutorOptions,
): Promise<ExecuteFn> {
  // Configuration first, before anything is retrieved.
  if (options.target === undefined) {
    throw new TypeError(
      `Gateway "${config.id}" has no upstream: set UPSTREAM_TARGET`,
    );
  }
  const target = parseTarget(options.target);
  // A Map, never an object: the name is looked up at request time.
  const operations = new Map(Object.entries(config.operations));
  for (const [name, op] of operations) {
    if (op.method.length === 0) {
      throw new TypeError(`Operation "${name}" must name a method`);
    }
  }

  // Then the secret, so a missing or invalid token stops the gateway starting.
  const token = tokenReader(options.secret, config.driver.tokenField);
  await token();

  return async (ctx, operation, input) => {
    const op = operations.get(operation);
    if (op === undefined) {
      throw new GatewayError("INTERNAL", `Unknown operation "${operation}"`);
    }
    const client = createClient(ctx, target, token);
    if (op.handler !== undefined) return op.handler(input as never, client);
    return { outcome: "ok", data: await client.call(op.method, input) };
  };
}

function parseTarget(value: string): URL {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  const loopback =
    url?.hostname === "localhost" || url?.hostname === "127.0.0.1";
  if (
    url === undefined ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  ) {
    throw new TypeError("UPSTREAM_TARGET must be an https URL");
  }
  return url;
}

// Reads the named field on every call, from the runtime's cached copy, and checks it before it
// reaches a header. A diagnostic names the field and the rule, never the value.
function tokenReader(secret: SecretProvider, field: string): TokenReader {
  return async (options) => {
    let values;
    try {
      values = await secret.get(options);
    } catch {
      throw new GatewayError(
        "INTERNAL",
        "The gateway secret could not be read",
      );
    }
    const value = Object.hasOwn(values, field) ? values[field] : undefined;
    if (typeof value !== "string" || !/^[\x21-\x7E]+$/.test(value)) {
      throw new GatewayError(
        "INTERNAL",
        `Secret field "${field}" must be a non-empty string of visible ASCII`,
      );
    }
    return value;
  };
}

function createClient(
  ctx: DriverContext,
  target: URL,
  token: TokenReader,
): JsonRpcClient {
  return {
    // One ctx.upstream per call; the request is built inside it, once per attempt.
    call: (method, params) =>
      ctx.upstream(async (signal) => {
        // Read before the transport's try, so a secret that cannot be read stays INTERNAL
        // instead of being reported as the upstream's failure.
        const bearer = await token();
        let response: Response;
        try {
          response = await fetch(target, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              authorization: `Bearer ${bearer}`,
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            redirect: "manual",
            signal,
          });
        } catch {
          // A library error can carry the request; none of it is kept. An aborted attempt is
          // reported by the runtime as UPSTREAM_TIMEOUT whatever is thrown here.
          throw new GatewayError(
            "UPSTREAM_ERROR",
            `Method "${method}": transport failure`,
          );
        }

        // Reported before anything can fail, under the name the gateway declares.
        const requestId = response.headers.get("x-request-id");
        if (requestId !== null) ctx.meta("upstreamRequestId", requestId);

        if (response.status === 401 || response.status === 403) {
          // The token may have been rotated: the next request reads the store again. A call is
          // a write as far as the driver knows, so this one is not sent again.
          await token({ fresh: true }).catch(() => undefined);
          ctx.log.warn("Upstream refused the gateway's credentials", {
            status: response.status,
          });
          throw new GatewayError(
            "UPSTREAM_REJECTED",
            `Method "${method}": credentials refused`,
          );
        }
        if (response.status >= 500) {
          throw new GatewayError(
            "UPSTREAM_ERROR",
            `Method "${method}": status ${response.status}`,
          );
        }
        if (response.status !== 200) {
          throw new GatewayError(
            "UPSTREAM_REJECTED",
            `Method "${method}": status ${response.status}`,
          );
        }

        // Bound the body before buffering it in a real driver; see the checklist.
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new GatewayError(
            "UPSTREAM_CONTRACT_VIOLATION",
            `Method "${method}": body is not JSON`,
          );
        }
        if (typeof body !== "object" || body === null) {
          throw new GatewayError(
            "UPSTREAM_CONTRACT_VIOLATION",
            `Method "${method}": not a JSON-RPC response`,
          );
        }
        if (Object.hasOwn(body, "error")) {
          // The upstream's code is a number; its message is text it wrote, and is not logged.
          const { error } = body as { error?: { code?: unknown } | null };
          const code = typeof error?.code === "number" ? error.code : null;
          ctx.log.info("Upstream answered with an error", { rpcCode: code });
          throw new GatewayError(
            "UPSTREAM_REJECTED",
            `Method "${method}": error response`,
          );
        }
        return (body as { result?: unknown }).result ?? null;
      }),
  };
}
```

A production driver would also:

- limit the size of the response body before buffering it, as openapi-rest's `maxResponseBytes`
  does;
- accept in a diagnostic only the transport and system error names it knows.

## 7. The entry module

```ts title="src/index.ts"
export type {
  JsonRpcDriver,
  JsonRpcDriverConfig,
  JsonRpcGatewayConfig,
  JsonRpcOperationFields,
} from "./config/definition.ts";
export { jsonRpc } from "./config/definition.ts";
export { defineHandler } from "./config/handler.ts";
export type { JsonRpcClient, JsonRpcHandler } from "./types.ts";
export { JSON_RPC_DRIVER_TYPE } from "./types.ts";
```

If a driver registers an
[operation refinement](/flex-platform/drivers/contract/#operation-refinements), it imports the
module that declares it here, for its side effect. Every consumer then has it.

## Using it

```ts title="gateways/services/example/gateway.config.ts"
import { defineGateway } from "@repo/gateway-config";
import { defineHandler, jsonRpc } from "@repo/gateway-driver-json-rpc";

const findRecord = defineHandler(async (input: { id: string }, client) => {
  const result = await client.call("records.get", input);
  return result === null
    ? { outcome: "missing" as const, data: null }
    : { outcome: "ok" as const, data: result };
});

const recordId = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
};
const record = { type: "object", properties: { id: { type: "string" } } };

export default defineGateway({
  id: "example",
  driver: jsonRpc({ tokenField: "apiToken" }),
  operations: {
    getRecord: {
      method: "records.get",
      input: recordId,
      outcomes: { ok: record },
      log: { input: ["id"] },
    },
    findRecord: {
      method: "records.get",
      input: recordId,
      outcomes: { ok: record, missing: { type: "null" } },
      handler: findRecord,
    },
  },
});
```

Nothing else changes. `pnpm schemas` writes `schemas/0001.json` from the declared schemas. The
[generated entry point](/flex-platform/codegen/entry-point/) reaches the driver as `config.driver`,
and codegen calls its `checkSchemas`.

## Testing

Test the driver, not the gateways that use it. In the driver's own package, cover:

- the executor against a local server or a stubbed transport: outcomes, each status or error it
  maps, a transport failure, and an abort;
- that startup refuses a missing target, a missing or invalid secret field, and invalid
  configuration, and that the diagnostic never contains the secret's value;
- that every request-time failure is a `GatewayError` whose message holds no payload value,
  credential or upstream text;
- deriving: that it answers with the schemas a configuration declares, or reads, and notes what
  it departs from;
- `checkSchemas` against schemas that agree and disagree with a configuration;
- at the type level, that `defineGateway` keeps literal operation names, refuses a misspelt
  operation field, and refuses a handler branded for another driver.

Generation, bundling and dispatch are already covered against the fixture gateway in
`gateways/shared/codegen/test/`, whose `stubDriver` is the smallest possible driver.

## Rules a driver must keep

Breaking one of these rules is silent: the build stays green, but the behaviour is wrong somewhere
else. Each rule is stated in full, with its reasoning, in
[the design constraints](/flex-platform/reference/design-constraints/).

**Transport**

- The driver is the only package that names its transport's vocabulary. Callers see outcome names
  such as `ok`, never a status or a header. `meta` names are neutral too.
- Nothing outside a configuration names a driver package. An entry point that would need to know
  about a specific driver is a design error.

**Upstream calls**

- Make each upstream call with `ctx.upstream(fn)`, once per call. `fn` builds its request each
  time and never retries. The driver expresses no retry behaviour.
- Wire the abort signal into the transport. The runtime limits `fn` either way, but an ignored
  signal leaks the connection.
- Disable SDK retries (`maxAttempts: 1`) on any AWS SDK client that calls the upstream. A retry
  there could repeat a write. Clients that only read, such as the secret or an assumed role, may
  keep their retries.
- The only request sent twice is a GET the upstream refused for its credentials. It is sent once
  more, inside the same attempt, with the secret read again. A write that is refused is never sent
  again.

**Failures and logging**

- Raise request-time failures as `GatewayError`, with `INTERNAL` for configuration bugs. Never let
  a library error escape with its message, because the message can carry a payload.
- Log through `ctx.log`: a message and scalar fields of the driver's own. Never a credential, a
  payload value, or text a caller or an upstream wrote.
- Report beside a result through `ctx.meta`, as soon as the value is known.

**Configuration and secrets**

- Everything that can fail does so in `createExecutor`, before it resolves: configuration first,
  then the secret, then authentication state. A request never finds a configuration error.
- Take the secret from `options.secret`. Take the location from `options.target`, or from a field
  of the secret the configuration names. Refuse to start if there is neither.
- Read only the secret fields the configuration names, none by default. Check every one on the
  initial read and every read after it, before any value reaches authentication code. A
  diagnostic names the field and the rule, never the value.
- Nothing in `config/` reads a secret, the environment or the network when it is imported.
- Look up anything named at request time in a `Map`, never a plain object.

**Contracts**

- Brand the handler type with the driver's `type`. Only the driver's `defineHandler` produces it.
- Keep the driver's own checks relating configuration to schemas in `checkSchemas`, and type-level
  ones in an `OperationRefinements` augmentation. The generator and config package hold no driver
  vocabulary.
- If the driver derives schemas, give the module as a `file:` URL and never import it.
- When deriving, close inputs and keep their constraints exactly. Open outcomes and drop their
  bounds.
