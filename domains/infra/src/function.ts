import { Duration } from "aws-cdk-lib";

import type { FunctionConfig } from "./config.ts";

export const FUNCTION_DEFAULTS: Required<FunctionConfig> = {
  timeoutSeconds: 15,
  memorySize: 1024,
};

export interface FunctionLimit {
  readonly min: number;
  readonly max: number;
}

export const FUNCTION_LIMITS: Readonly<
  Record<keyof FunctionConfig, FunctionLimit>
> = {
  timeoutSeconds: { min: 1, max: 29 },
  memorySize: { min: 128, max: 10_240 },
};

export interface FunctionSettings {
  readonly timeout: Duration;
  readonly memorySize: number;
}

export function functionSettingsFor(
  overrides: FunctionConfig = {},
): FunctionSettings {
  const { timeoutSeconds, memorySize } = { ...FUNCTION_DEFAULTS, ...overrides };

  return {
    timeout: Duration.seconds(timeoutSeconds),
    memorySize,
  };
}
