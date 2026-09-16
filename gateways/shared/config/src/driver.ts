import type {
  ExecuteFn,
  GatewaySchemas,
  OperationHandler,
  SecretProvider,
} from "@repo/gateway-types";

import type { GatewayConfig, OperationConfig } from "./types.ts";

// What an entrypoint supplies to any driver: the values the runtime reads from the environment.
// Everything else, handlers included, is in the configuration. Nothing here names a transport
// or says what the secret holds, so a generated entrypoint is the same for every driver.
export interface ExecutorOptions {
  // UPSTREAM_TARGET, as the driver interprets it.
  readonly target: string;
  // The secret UPSTREAM_SECRET_ARN names, as a provider rather than an ARN or a client. The
  // driver, or the authentication implementation its definition names, validates what it holds.
  readonly secret: SecretProvider;
}

export type AnyOperations<TDriver extends DriverDefinition> = Readonly<
  Record<string, OperationConfig<TDriver>>
>;

export interface DriverDefinition<
  TOpFields extends Record<string, unknown> = Record<string, unknown>,
  THandler extends OperationHandler = OperationHandler,
> {
  readonly type: string;
  // The driver's behaviour travels with its definition. An entrypoint imports the configuration
  // for its operations and handlers anyway, so it reaches the driver as `config.driver` and
  // never names a driver package; codegen loads the configuration the same way. Asynchronous
  // so that the initial secret is retrieved, validated and turned into authentication state
  // before the executor exists: a missing or invalid secret fails here, at startup, and never
  // on a request.
  //
  // The configuration arrives typed as the runtime holds it. A driver writes its factory
  // against its own configuration type and sets it here, which a method parameter permits;
  // BaseOperationConfig is a type alias so that the driver's operation type relates to the
  // generic one. A parameter typed with `this` would be more precise but cannot be checked:
  // relating a driver to this interface would then relate the two configuration types, which
  // relates the drivers again.
  createExecutor(
    config: GatewayConfig<DriverDefinition, AnyOperations<DriverDefinition>>,
    options: ExecutorOptions,
  ): Promise<ExecuteFn>;
  // Operation schemas derived from the driver's own description of the upstream. Optional
  // until every driver provides it; codegen reads schemas.fixture.ts when absent.
  deriveSchemas?(
    config: GatewayConfig<DriverDefinition, AnyOperations<DriverDefinition>>,
  ): Promise<GatewaySchemas>;
  // Phantom properties - give TypeScript structural anchors to infer TOpFields and THandler
  // from a driver instance via OperationFields<D> and HandlerOf<D>. Never set at runtime.
  readonly __opFields?: TOpFields;
  readonly __handler?: THandler;
}

export type OperationFields<D> =
  D extends DriverDefinition<infer F, OperationHandler> ? F : never;

// The custom handler signature a driver expects, so an entrypoint's handler map and the
// modules it imports are checked against it.
export type HandlerOf<D> =
  D extends DriverDefinition<Record<string, unknown>, infer H> ? H : never;

declare const HANDLER_DRIVER: unique symbol;

// A handler written for one driver. The driver's defineHandler applies the brand as a
// type-level claim; no property exists at runtime. A driver declares its branded handler type
// on its definition, so an entrypoint's handler map rejects a plain function or a handler from
// another driver, even one whose client happens to look the same.
export type BrandedHandler<
  TType extends string,
  THandler extends OperationHandler,
> = THandler & { readonly [HANDLER_DRIVER]: TType };

declare const NO_REFINEMENT: unique symbol;

// A driver can refine the type each of its operations must satisfy, for checks that relate one
// field to another, such as a path template to the parameters that fill it. The driver augments
// this interface with a member keyed by its literal `type`; the member receives the operation as
// written and returns the type it must be assignable to. This package holds only the slot.
export interface OperationRefinements<TOp> {
  // Never a driver type. Keeps TOp in the base declaration, which every augmentation must match.
  readonly [NO_REFINEMENT]?: TOp;
}

export type RefineOperation<
  TDriver extends DriverDefinition,
  TOp,
> = TDriver["type"] extends keyof OperationRefinements<TOp>
  ? OperationRefinements<TOp>[TDriver["type"]]
  : TOp;
