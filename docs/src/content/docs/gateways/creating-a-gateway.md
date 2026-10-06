---
title: Creating a gateway
description: Add a gateway package for a new upstream, from package.json to generated output.
---

A gateway is a package under `gateways/services/`. It holds a configuration, its versioned schemas
and any custom handlers. It has no tests of its own apart from tests for its handlers. The
libraries' tests cover generation, bundling and dispatch.

This walk-through uses the [openapi-rest driver](/flex-platform/drivers/openapi-rest/overview/).
If that driver cannot reach your upstream,
[write a driver](/flex-platform/drivers/writing-a-driver/) first.

## 1. Create the package

```txt
gateways/services/example/
  package.json
  tsconfig.json
  eslint.config.ts
  gateway.config.ts
  config/          optional: schemas and constants the configuration imports
  schemas/         written by gateway-schemas
```

```json title="package.json"
{
  "name": "@govuk-once/flex-gateway-example",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "codegen": "gateway-codegen",
    "schemas": "gateway-schemas",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@repo/gateway-config": "workspace:*",
    "@repo/gateway-driver-openapi-rest": "workspace:*",
    "@repo/gateway-runtime": "workspace:*"
  },
  "devDependencies": {
    "@repo/eslint-config": "workspace:*",
    "@repo/gateway-codegen": "workspace:*",
    "@repo/gateway-types": "workspace:*",
    "@repo/tsconfig": "workspace:*",
    "eslint": "10.10.0"
  }
}
```

`pnpm codegen` and `pnpm schemas` run the `codegen` and `schemas` scripts across the workspace.
Pin `eslint` at the same version as the rest of the workspace.

```json title="tsconfig.json"
{
  "extends": "@repo/tsconfig/base.json",
  "include": ["*.config.ts", "config"]
}
```

```ts title="eslint.config.ts"
export { service as default } from "@repo/eslint-config";
```

The `service` preset blocks common network globals and builtins to help keep upstream access in
the driver. It is a lint check, not complete network isolation; review dependencies and custom
handlers for transport access too. Run `pnpm install` to link the package.

## 2. Configure the gateway

```ts title="gateway.config.ts"
import { defineGateway } from "@repo/gateway-config";
import { apiKey, fromSecret, openapiRest } from "@repo/gateway-driver-openapi-rest";

export default defineGateway({
  id: "example",
  description: "Example upstream gateway",
  driver: openapiRest({
    // Pin to a release or commit: the schemas are derived from what this names.
    spec: "https://example.gov.uk/openapi/v1.2.0.json",
    auth: [apiKey({ header: "x-api-key", key: fromSecret("apiKey") })],
  }),
  operations: {
    getRecord: {
      description: "Read a record by its id",
      upstream: "GET /v1/records/{id}",
      parameters: { recordId: { in: "path", name: "id" } },
      log: { input: ["recordId"], output: ["status"] },
    },
  },
});
```

Choose `id` carefully. It is the gateway's identity, and if the contract has to break later, the
gateway needs a new one. See [Configuring a gateway](/flex-platform/gateways/configuration/) for
every field, and [the openapi-rest overview](/flex-platform/drivers/openapi-rest/overview/) for
`upstream` and `parameters`.

## 3. Derive the schemas

```bash
pnpm --filter @govuk-once/flex-gateway-example schemas
```

When there are no versions yet, this writes `schemas/0001.json` from the OpenAPI document. It also
prints notes for a reviewer to read, such as:

- an input object it closed
- an optional parameter that nothing maps
- a keyword it dropped

Read the file before you commit it. It is the contract that callers will compile against.

## 4. Generate

```bash
pnpm --filter @govuk-once/flex-gateway-example codegen
```

This checks the configuration against the schemas and writes `.gen/`. It lists every problem in
one run. Fix each one. See [What codegen checks](/flex-platform/codegen/checks/).

## 5. Prepare for deployment

The deployment artifact is `.gen/runtime/bundle.mjs`, for a Node 24 Lambda function with handler
`bundle.handler`. This repository does not yet provision the function, its permissions or its
network. See [The platform](/flex-platform/start/platform/) for the planned hosting model.

Set the [environment](/flex-platform/reference/environment/):

- `UPSTREAM_SECRET_ARN`, always
- `UPSTREAM_TARGET`, unless the driver reads the target from the secret

The function's role needs permission to read that secret, plus any permissions its authentication
requires. See [Environment](/flex-platform/reference/environment/). Callers use `.gen/client/rpc.ts`
for the [call contract](/flex-platform/codegen/call-contract/); it provides types, not an invocation
client.

## Changing it later

To follow the upstream, point `spec` at its newer release and run `schemas` again. If the change
is safe for callers, it writes `0002.json`. If it is not, it fails and lists every break. Never
edit a merged version. CI refuses it.
