---
title: Creating a gateway
description: Add a gateway package for a new upstream, from package.json to generated output.
---

A gateway is a package under `gateways/services/`. It holds a configuration, its versioned schemas
and any custom handlers. Its only tests are tests for its handlers. The libraries' tests cover
generation, bundling and dispatch.

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
  "name": "@repo/gateway-service-example",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "codegen": "gateway-codegen",
    "schemas": "gateway-schemas",
    "lint": "eslint gateway.config.ts config/",
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
    "@repo/gateway-core": "workspace:*",
    "@repo/tsconfig": "workspace:*",
    "eslint": "10.15.0"
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

The `service` preset blocks common network globals and builtins, to help keep upstream access in
the driver. It is a lint check, not complete network isolation. Review dependencies and custom
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

Choose `id` carefully. It is the gateway's identity. If the contract has to break later, the
gateway needs a new one. See [Configuring a gateway](/flex-platform/gateways/configuration/) for
every field, and [the openapi-rest overview](/flex-platform/drivers/openapi-rest/overview/) for
`upstream` and `parameters`.

## 3. Derive the schemas

```bash
pnpm --filter @repo/gateway-service-example schemas
```

If there are no versions yet, this writes `schemas/0001.json` from the OpenAPI document. It also
prints notes for a reviewer to read, such as:

- an input object it closed
- an optional parameter that nothing maps
- a keyword it dropped

Read the file before you commit it. It is the contract that callers will compile against.

## 4. Generate

```bash
pnpm --filter @repo/gateway-service-example codegen
```

This checks the configuration against the schemas and writes `.gen/`. It checks in stages. It
lists every problem that the first failing stage finds, so fixing those can uncover more. Run it
until it passes. See [What codegen checks](/flex-platform/codegen/checks/).

## 5. Prepare for deployment

The gateway deploys as a Lambda function named `gateway-<environment>-<id>`.
`gatewayFunctionName` in `@repo/gateway-core` builds the name. The function has one alias, `live`,
which every [gateway client](/flex-platform/domains/calling-gateways/) invokes.

To deploy it:

1. List it in `gateways` on each domain account that runs it, in the
   [CDK app's config](/flex-platform/infrastructure/overview/#config).
2. Add its package to `@repo/infra-app`'s dependencies.

The config entry names every host the gateway connects to: its upstream's API, and any host it
takes a token from. The network resolves only the names on its DNS allowlist, and a name left off
doesn't resolve. See [the allowlist](/flex-platform/infrastructure/network/#the-allowlist). The
entry also gives the gateway's placement, its secret, its target and the roles it signs as.

A secret that the gateway's stack creates starts empty. Put its value before anything calls the
gateway, or the gateway fails as it starts.

[Environment](/flex-platform/reference/environment/) covers what the function runs, the variables
it reads and what its role needs. Callers install the
[client package](/flex-platform/codegen/overview/#the-client-package) in `.gen/client/package/`. It
holds the [call contract](/flex-platform/codegen/call-contract/), and a function that creates a
client typed by it.

## Changing it later

To follow the upstream, point `spec` at its newer release and run `schemas` again. If the change
is safe for callers, the command writes `0002.json`. If it is not, the command fails and lists
every break. Never edit a merged version. CI refuses the change.
