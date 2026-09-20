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
  // Whether the configuration and the schemas describe the same requests, in the relations only
  // the driver can read: a path template against the input fields that fill it, say. Codegen
  // calls it before it emits anything and fails the run with every message returned, so a
  // mismatch is a generation error rather than a request that fails in production. Returning
  // the findings rather than throwing lets one run report all of them. Optional: a driver with
  // nothing to relate omits it.
  checkSchemas?(
    config: GatewayConfig<DriverDefinition, AnyOperations<DriverDefinition>>,
    schemas: GatewaySchemas,
  ): readonly string[];
  // The module that derives this driver's schemas from its own description of the upstream: an
  // OpenAPI document, say. Given as a `file:` URL, not imported. A generated entry point imports
  // the configuration, and the bundler follows every import it can see from there, a dynamic one
  // included, so a module imported here would carry whatever parses that description into the
  // deployed gateway. A URL is data: a driver builds it from its own module,
  // `new URL("../derive/index.ts", import.meta.url).href`, only the command that updates a
  // gateway's schemas loads it, and it must export a DeriveSchemas as its default. Optional: the
  // schemas of a driver with nothing to derive them from are written by hand.
  readonly deriveSchemasModule?: string;
  // Phantom properties - give TypeScript structural anchors to infer TOpFields and THandler
  // from a driver instance via OperationFields<D> and HandlerOf<D>. Never set at runtime.
  readonly __opFields?: TOpFields;
  readonly __handler?: THandler;
}

// What deriving is given to read an upstream's description with. The command supplies it, so
// one place decides what may be fetched and for how long, and a driver's derivation reaches the
// network through nothing else.
export interface SchemaSources {
  // The text at a location: an https URL, or a path within the gateway's own directory.
  load(location: string): Promise<string>;
}

export interface DerivedSchemas {
  readonly schemas: GatewaySchemas;
  // Where deriving departed from what the upstream wrote, or left something out, for whoever
  // reviews the result: a type it supplied, a parameter the configuration does not map.
  readonly notes: readonly string[];
}

// The default export of the module a definition gives in `deriveSchemasModule`.
export type DeriveSchemas = (
  config: GatewayConfig<DriverDefinition, AnyOperations<DriverDefinition>>,
  sources: SchemaSources,
) => Promise<DerivedSchemas>;

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
