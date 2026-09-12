import type { DriverDefinition, OperationFields } from "./driver.ts";

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

export interface BaseOperationConfig {
  readonly log?: LogConfig;
  // Input path -> secure value key. Requires equal values; does not authenticate their origin.
  readonly secure?: Readonly<Record<FieldPath, string>>;
  readonly handler?: string;
  readonly description?: string;
}

export type OperationConfig<D extends DriverDefinition = DriverDefinition> =
  BaseOperationConfig & OperationFields<D>;

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
