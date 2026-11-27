---
title: Code generation
description: What gateway-codegen reads, what it writes, and in what order.
sidebar:
  label: Overview
---

`gateway-codegen` runs in a gateway package. It loads `gateway.config.ts` and the latest version in
`schemas/`, and writes everything it generates to `.gen/`:

```bash
pnpm --filter @repo/gateway-service-udp codegen   # one gateway
pnpm codegen                                         # every gateway with a codegen script
```

There is no build step. The CLI runs from source. `bin/gateway-codegen.js` registers tsx and
imports `src/cli.ts`. So the CLI and the configurations it loads can use all of TypeScript, not
only the subset that Node can strip on its own.

## Output

The output is split into two directories because they are deployed separately. `runtime/` is what
the gateway runs. `client/` is what a service that calls the gateway imports.

| Path | Contents |
|---|---|
| `.gen/runtime/entry.js` | The handler. It combines the configuration, the validators and the executor the driver builds. It reads the environment and exports `handler`. See [The entry point](/flex-platform/codegen/entry-point/). |
| `.gen/runtime/validators/` | Standalone Ajv validators: one for each operation's input, each declared outcome and each `meta` name. `schemas.js` holds them, as self-contained JavaScript with no package imports. `index.js` maps each operation, and each `meta` name, to its validators. |
| `.gen/runtime/bundle.mjs` | `entry.js` and everything it imports, bundled by esbuild as ESM for Node 26. Only Node's builtins are left for the platform to resolve. This is the deployed artifact, and its handler is `bundle.handler`. |
| `.gen/client/rpc.ts` | The call contract as types: each operation's input and the union of its outcomes. See [The call contract](/flex-platform/codegen/call-contract/). |
| `.gen/client/index.ts` | The contract, and a function named for the gateway, such as `createUdpClient`, that creates a [gateway client](/flex-platform/domains/calling-gateways/) typed by it. Codegen builds the client package from it. |
| `.gen/client/package/` | The [client package](#the-client-package) a domain installs: `package.json`, `index.js` and `index.d.ts`. |

No package includes `.gen/` in its TypeScript project, so nothing typechecks either half where it
is written. Nothing outside `.gen/` imports the runtime half. The generated entry point, also in
`.gen/`, reads the validators.

`client/` is different. A domain installs its package, and typechecks against it with its own
sources. Codegen tests compile a generated contract, and typecheck a domain against the fixture
gateway's package. So the generated output is checked in at least one place.

## Order of a run

Codegen checks a gateway before it writes anything:

1. It loads the configuration. It reads every schema version and checks its shape.
2. It compiles the latest version's schemas in Ajv's strict mode.
3. It compares each version with every version before it. See
   [Compatibility](/flex-platform/gateways/compatibility/).
4. It checks the configuration against the latest version, first generically and then through the
   driver's `checkSchemas`. See [What codegen checks](/flex-platform/codegen/checks/).
5. If the driver can derive without the network, it checks that the latest version is what the
   driver derives. See [What the driver derives](/flex-platform/codegen/checks/#what-the-driver-derives).
6. It deletes `.gen/` and writes it again with the validators, entry point, bundle, contract and
   client package.

If these checks reject a gateway, its existing output stays. After that point, writing and
bundling can still fail. So can the contract, which refuses a schema it cannot express as types,
such as two names that would collide. A failure there fails the command and leaves an incomplete
`.gen/`. The next run replaces it.

## Guarantees and limits

- **Each run reads from disk.** It reads `gateway.config.ts` and the latest version in `schemas/`
  from the files on disk, not from anything a process loaded earlier. This matters because the
  entry point imports the configuration, and esbuild reads it again when it bundles.
- **One gateway is generated per process.** Node reuses a module it has already evaluated, and
  codegen cannot remove one from its cache. On a second run in the same process, whatever the
  configuration imports would be out of date. So the command does one run.
- **One run at a time for each generated directory.** Nothing coordinates two runs, and one
  command generates a gateway.
- **The bundle is built during generation, not at deployment.** A gateway that cannot be bundled
  fails at a point where the cause is easy to find. The same gateway always bundles to the same
  bytes.

## The client package

`.gen/client/package/` is the gateway's client as a package a domain installs. It is named
`@govuk-once/flex-gateway-<id>-client`. It exports the contract's types and one function, named
for the gateway, such as `createUdpClient` for `udp`. So a domain that imports several gateways'
packages has no two exports of the same name.

The function takes nothing. It creates a
[gateway client](/flex-platform/domains/calling-gateways/) for the gateway's function. The
gateway client names that function from the id and the domain's environment. The client has a
function for each operation the latest schema version holds. The package lists their names,
because the contract's types are gone at runtime.

Codegen [refuses](/flex-platform/codegen/checks/#generic-checks) an id that can't name the
package or the function, and an operation named `then`, before it writes anything.

rolldown builds `index.js` and `index.d.ts` in one pass from `client/index.ts`, so the two agree
on what is external:

- It leaves the gateway client, `@govuk-once/flex-gateway-client`, external. The package names it
  as its one peer dependency. So a domain calling several gateways has one copy of the client, and
  one `GatewayInvocationError`.
- It bundles in the shared types the contract names from `@repo/gateway-core`, which is not
  published.

Codegen resolves both from its own dependencies, so a gateway declares neither.

The declarations are written from each module on its own, as TypeScript's
`isolatedDeclarations` does. This is because the compiler emits none for a file it reaches through
`node_modules`, and that is how the workspace links its packages. So every export of
`@repo/gateway-core` states its type. If a module does not, generation fails, naming the file and
the line.

The package's version has three parts:

1. the gateway client's major
2. the number of the gateway's latest schema version
3. `0`

So it is `0.1.0` for a gateway at `0001.json` and client `0.1.0`, and `0.10.0` at `0010.json`.
Writing a schema version raises it with nothing else to change. A client at `1.x` takes every
gateway's package to `1.<n>.0` on its next generation.

The package's peer range is the client it was generated with, and every later release of that
major, such as `>=0.1.0 <1.0.0`. The range is spelled out because under `1.0.0` a caret admits only
the same minor. This is the version codegen writes. A release keeps its major and minor and sets
the patch. See [Releasing packages](/flex-platform/start/releasing/).

## Validators

Validators are Ajv standalone code, generated from the latest schemas. They are self-contained
JavaScript. Codegen bundles Ajv's runtime helpers and formats into them at generation time,
resolving them from its own dependencies. This means:

- the validators run without codegen or Ajv installed;
- no one keeps a manual list of helpers;
- the validators have no package imports and no declaration files.

The validators read only the fields an object holds, never fields it inherits. Every value a
validator sees was parsed from JSON, so it inherits from `Object.prototype`. Without this rule, the
prototype would answer a schema naming `constructor` or `toString`. An empty object would then
satisfy a requirement for such a field.
