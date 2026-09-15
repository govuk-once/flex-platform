import type { DriverDefinition } from "./driver.ts";
import { standardPolicy } from "./presets.ts";
import type { GatewayConfig, OperationConfig } from "./types.ts";

// Inferred operation types keep every key the author wrote, so a misspelled field such as
// `hanlder` would otherwise pass. Each key not in the operation type must be `never`, which
// the value never is; the error lands on the misspelled property.
type ExactKeys<TExpected, TActual> = {
  readonly [K in Exclude<keyof TActual, keyof TExpected>]: never;
};

// Operation keys and literals are inferred from the plain GatewayConfig side; NoInfer keeps the
// checks out of inference.
export function defineGateway<
  const TDriver extends DriverDefinition,
  const TOps extends Readonly<Record<string, OperationConfig<TDriver>>>,
>(
  config: GatewayConfig<TDriver, TOps> & {
    readonly operations: NoInfer<{
      readonly [K in keyof TOps]: TOps[K] &
        ExactKeys<OperationConfig<TDriver>, TOps[K]>;
    }>;
  },
): GatewayConfig<TDriver, TOps> {
  return { ...config, policy: { ...standardPolicy, ...config.policy } };
}
