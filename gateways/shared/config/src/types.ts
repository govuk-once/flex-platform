import type { DriverDefinition, HandlerOf, OperationFields } from "./driver.ts";

export type FieldPath = string;

export interface LogConfig {
  readonly input?: readonly FieldPath[];
  readonly output?: readonly FieldPath[];
}

// Only upstreamTimeout is enforced. Other fields are accepted but have no enforcement effect.
export interface PolicyConfig {
  readonly upstreamTimeout?: string;
  readonly circuitBreaker?: {
    readonly threshold?: number;
    readonly duration?: string;
  };
  readonly rateLimit?: {
    readonly rps?: number;
  };
}

// A type alias, not an interface: an operation's type intersects this with the driver's fields,
// and only an intersection of type literals is assignable to the `Record<string, unknown>` that
// stands for those fields in a driver-agnostic configuration. A driver's createExecutor relies
// on that to take its own configuration type.
export type BaseOperationConfig = {
  readonly log?: LogConfig;
  // Input path -> secure value key. Requires equal values; does not authenticate their origin.
  readonly secure?: Readonly<Record<FieldPath, string>>;
  readonly description?: string;
};

export type OperationConfig<D extends DriverDefinition = DriverDefinition> =
  BaseOperationConfig &
    OperationFields<D> & {
      // A custom handler for this operation, imported statically into the configuration and
      // typed against the driver, so the wrong driver's handler fails here.
      readonly handler?: HandlerOf<D>;
    };

export interface GatewayConfig<
  TDriver extends DriverDefinition,
  TOps extends Readonly<Record<string, OperationConfig<TDriver>>>,
> {
  readonly id: string;
  readonly description?: string;
  readonly driver: TDriver;
  readonly policy?: PolicyConfig;
  readonly operations: TOps;
}
