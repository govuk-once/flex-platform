import type { DriverDefinition, ExecutorOptions } from "@repo/gateway-config";
import type { ExecuteFn } from "@repo/gateway-types";

// A driver with no transport: enough to generate, bundle and dispatch without involving a driver
// package. The generated entry point, the configuration and a test all reach this module, so a
// test decides what the executor answers and sees the options the entry point passed it.
export interface Stub {
  execute: ExecuteFn;
  options: ExecutorOptions | undefined;
}

// The default answers an operation, so the bundle can be run in a subprocess that has no way to
// set one. A test in this process replaces it.
export const stub: Stub = {
  execute: () =>
    Promise.resolve({ outcome: "created", data: { id: "fixture" } }),
  options: undefined,
};

export function stubDriver(): DriverDefinition {
  return {
    type: "stub",
    createExecutor: (_config, options) => {
      stub.options = options;
      return Promise.resolve((ctx, operation, input) =>
        stub.execute(ctx, operation, input),
      );
    },
  };
}
