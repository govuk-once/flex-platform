import type { DriverDefinition } from "./driver.ts";
import { standardPolicy } from "./presets.ts";
import type { GatewayConfig, OperationConfig } from "./types.ts";

export function defineGateway<
  const TDriver extends DriverDefinition,
  const TOps extends Readonly<Record<string, OperationConfig<TDriver>>>,
>(config: GatewayConfig<TDriver, TOps>): GatewayConfig<TDriver, TOps> {
  return { ...config, policy: { ...standardPolicy, ...config.policy } };
}
