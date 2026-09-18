import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  DriverDefinition,
  GatewayConfig,
  OperationConfig,
} from "@repo/gateway-config";
import type { GatewaySchemas } from "@repo/gateway-types";

import { CONFIG_FILE, SCHEMAS_FILE } from "./layout.ts";

// A configuration as codegen holds it: the driver is opaque, and its operations carry whatever
// fields that driver defines.
export type AnyGatewayConfig = GatewayConfig<
  DriverDefinition,
  Readonly<Record<string, OperationConfig>>
>;

// The bytes of the module, as a name a URL can carry.
async function digestOf(modulePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(modulePath))
    .digest("hex")
    .slice(0, 32);
}

async function loadModule<T>(absPath: string): Promise<T> {
  const url = pathToFileURL(absPath);
  // A module is cached by its URL, so a file already imported in this process is read from
  // memory however it has changed since. The configuration and the fixture are each read under a
  // URL naming the bytes they were read from, so a run always evaluates the files it is generating
  // from, and a run that follows an unchanged file still costs nothing. Importing either reaches
  // no environment, secret or network by design, which is what makes reading it again safe.
  url.searchParams.set("read", await digestOf(absPath));
  const mod = (await import(url.href)) as { default: T };
  return mod.default;
}

// Loads TypeScript via Node's type stripping without a config compilation step. Importing a
// configuration reaches no environment, secret or network by design, so this runs anywhere.
export async function loadConfig(
  gatewayDir: string,
): Promise<AnyGatewayConfig> {
  return loadModule<AnyGatewayConfig>(path.resolve(gatewayDir, CONFIG_FILE));
}

export async function loadSchemas(gatewayDir: string): Promise<GatewaySchemas> {
  return loadModule<GatewaySchemas>(path.resolve(gatewayDir, SCHEMAS_FILE));
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
