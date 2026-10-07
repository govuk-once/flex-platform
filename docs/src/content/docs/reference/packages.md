---
title: Packages
description: Every workspace package, what it holds and what it may depend on.
---

Workspace libraries export their TypeScript sources directly and resolve to each other's sources.
They need no separate library build. Codegen emits and bundles gateway artifacts, and the docs
package builds the site with Astro.

## Gateway libraries

| Package | Directory | Holds |
|---|---|---|
| `@repo/gateway-types` | `gateways/shared/types` | Envelope shapes and `meta`, error codes and their health rulings, the `Validator` interface, the driver context and execute types, the schema shapes and the secret provider shape. Shared types and the `ERROR_CODES` constant, with no package dependencies. A consumer can name envelopes and error codes without installing the runtime or the generator. |
| `@repo/gateway-config` | `gateways/shared/config` | `defineGateway`, the `DriverDefinition` with its `createExecutor` contract and neutral `ExecutorOptions`, operation types, `OperationRefinements` and policy presets. |
| `@repo/gateway-runtime` | `gateways/shared/runtime` | Envelope parsing, `createHandler` and dispatch, input and outcome validation, secure value comparisons, upstream timeouts, payload field selection for logs, `GatewayError`, and retrieval of the gateway secret from AWS Secrets Manager through Powertools Parameters. |
| `@repo/gateway-codegen` | `gateways/shared/codegen` | Schema loading, version comparison, the build-time check of a configuration, standalone validator generation, the call contract and the entry point. Provides the `gateway-codegen` and `gateway-schemas` commands. |

## Drivers

| Package | Directory | Holds |
|---|---|---|
| `@repo/gateway-driver-openapi-rest` | `gateways/drivers/openapi-rest` | The HTTP driver: request construction, status mapping, authentication, custom handlers and schema derivation from OpenAPI. See [openapi-rest](/flex-platform/drivers/openapi-rest/overview/). |

## Gateways

| Package | Directory | Holds |
|---|---|---|
| `@govuk-once/flex-gateway-udp` | `gateways/services/udp` | The User Data Platform gateway: its configuration and versioned schemas. |

## Infrastructure

| Package | Directory | Holds |
|---|---|---|
| `@repo/infra-app` | `infra/app` | The CDK app: every stage's config and its checks. It builds one stage at a time. See [Infrastructure](/flex-platform/infrastructure/overview/). |

## Shared tooling

| Package | Directory | Holds |
|---|---|---|
| `@repo/tsconfig` | `packages/tsconfig` | `base.json`, the shared TypeScript base. It is strict and emits nothing. |
| `@repo/eslint-config` | `packages/eslint-config` | The `base`, `driver` and `service` presets. |
| `@repo/vitest-config` | `packages/vitest-config` | Shared Vitest configuration. |
| `@repo/utils` | `packages/utils` | Generic functions, one per module, each imported by its own path, such as `@repo/utils/sorted-entries`. |
| `@repo/docs` | `docs` | This site. |

## Conventions

Where code belongs, and how `@repo/utils` is exported and used for sorting, are in
[Conventions](/flex-platform/start/conventions/). Which package may depend on which is
[design constraint 10](/flex-platform/reference/design-constraints/).
