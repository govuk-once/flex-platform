# Flex Platform

The monorepo for the Flex Platform.

> **Status:** early. The structure is in place, but most of the tooling described below has not
> been built yet.

## Layout

```
gateways/     The service gateways
packages/     Shared toolchain
```

More top-level directories will be added alongside `gateways/`. Each one shares the toolchain in
`packages/` but owns its own code, contracts and release cycle. If something is used across the
whole repo it belongs in `packages/`, otherwise it stays where it is used. For example `gateways/`
has its own `shared/` directory for things common to gateways and nothing else.

## Gateways

A gateway is an internal service that owns exactly one upstream. A Flex service calls the
gateway instead of the upstream, and gets a stable typed interface, consistent errors, and
resilience built in: timeouts, retries, circuit breaking and rate limiting. Upstream credentials
never leave the gateway.

Upstreams include third party APIs and other services within the Once programme. From a consuming
service there is no difference between the two.

```
gateways/shared/     Libraries that make gateways work
gateways/services/   The gateways themselves, one per upstream
```

### Authoring a gateway

A gateway is written as a single `gateway.config.ts` describing the upstream and its operations.
Codegen produces everything else: the contract, validators, the deployable handler and a typed
client. In cases where codegen would not be sufficient we'll provide fallback to a handler
that can be written manually under that gateway.

Codegen is not implemented yet. When it is, the generated output will be produced on each build
rather than committed.

### Consuming a gateway

Install the generated client and call a method:

```ts
import { udp } from "@govuk-once/flex-gateway-udp";

const result = await udp.getNotifications({ id: "123" });
return result.data;
```

## Working in this repo

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

Node 24, pnpm and Turborepo. Add `--filter <package>` to scope a command to a single package.

Some dependencies are published to GitHub Packages under the `@govuk-once` scope. The repo ships
an `.npmrc` that expects a token in your environment. You need read access to that scope for
`pnpm install` to work.

Conventions and invariants for this repo live in [`CLAUDE.md`](./CLAUDE.md). It is written for AI
agents, but it is worth reading if you are working here too.

## Licence

MIT. See [`LICENSE`](./LICENSE).
