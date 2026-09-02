import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  DriverDefinition,
  GatewayConfig,
  OperationConfig,
} from "@repo/gateway-config";

import type { GatewaySchemas } from "./types.ts";

type AnyGatewayConfig = GatewayConfig<
  DriverDefinition,
  Readonly<Record<string, OperationConfig>>
>;

async function loadModule<T>(absPath: string): Promise<T> {
  const mod = (await import(pathToFileURL(absPath).href)) as { default: T };
  return mod.default;
}

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
