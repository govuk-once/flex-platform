import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  DriverDefinition,
  GatewayConfig,
  OperationConfig,
} from "@repo/gateway-config";
import type { GatewaySchemas } from "@repo/gateway-types";

// A configuration as codegen holds it: the driver is opaque, and its operations carry whatever
// fields that driver defines.
export type AnyGatewayConfig = GatewayConfig<
  DriverDefinition,
  Readonly<Record<string, OperationConfig>>
>;

async function loadModule<T>(absPath: string): Promise<T> {
  const mod = (await import(pathToFileURL(absPath).href)) as { default: T };
  return mod.default;
}

// Loads TypeScript via Node's type stripping without a config compilation step. Importing a
// configuration reaches no environment, secret or network by design, so this runs anywhere.
export async function loadConfig(
  gatewayDir: string,
): Promise<AnyGatewayConfig> {
  return loadModule<AnyGatewayConfig>(
    path.resolve(gatewayDir, "gateway.config.ts"),
  );
}

export async function loadSchemas(gatewayDir: string): Promise<GatewaySchemas> {
  return loadModule<GatewaySchemas>(
    path.resolve(gatewayDir, "schemas.fixture.ts"),
  );
}

// A driver that describes its own upstream produces the schemas; otherwise they come from the
// gateway's fixture. No driver implements deriveSchemas yet.
export async function loadGatewaySchemas(
  config: AnyGatewayConfig,
  gatewayDir: string,
): Promise<GatewaySchemas> {
  return config.driver.deriveSchemas === undefined
    ? loadSchemas(gatewayDir)
    : config.driver.deriveSchemas(config);
}
