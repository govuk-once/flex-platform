---
title: The entry point and bundle
description: The generated Lambda entry point, and what the bundle contains.
---

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

This module is the same for every gateway. The driver comes with the configuration and builds its
own executor, so the entry point names no driver package and no transport. If an entry point would
need to know about a specific driver or gateway, that is a design error.

`UPSTREAM_TARGET` and `UPSTREAM_SECRET_ARN` are read here, through `readUpstreamOptions`, and
nowhere else. The handler is built while the module loads, during the Lambda initialisation phase.
So the operations compile, and the secret is retrieved and validated, before the handler can
process an event. An initialisation failure occurs outside the handler's error envelope; it is
not a code-generation check of the deployed environment.

The handler is the only export. A gateway runs on Lambda, and the platform is its only caller.

The entry point is JavaScript, not TypeScript, for the same reason the validators have no
declaration files: a TypeScript module could not import them.

## The bundle

`.gen/runtime/bundle.mjs` is `entry.js` and everything it imports, bundled by esbuild as ESM for
Node 24. Its handler is `bundle.handler`.

The bundle includes everything the handler imports except Node's builtins. This includes the AWS
SDK, even though the Lambda runtime ships its own copy. An import left out of the bundle would be
resolved from the runtime's copy, at the version AWS last patched in. Every other dependency here
is pinned exactly.

A bundled CommonJS dependency reaches Node's builtins through `require`, which an ES module does
not have. So the bundle starts by creating its own `require` from `node:module`. Without it, the
bundle would throw as soon as it loaded, and the gateway would not start.

The bundler follows every import from the configuration, including dynamic imports. So anything a
configuration or driver definition imports is deployed. This is why a driver gives the module that
derives its schemas as a URL and does not import it. See
[The driver contract](/flex-platform/drivers/contract/#deriveschemasmodule).
