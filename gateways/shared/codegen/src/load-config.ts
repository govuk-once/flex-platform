import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  DriverDefinition,
  GatewayConfig,
  OperationConfig,
} from "@repo/gateway-config";

import { CONFIG_FILE } from "./layout.ts";

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
  // memory however it has changed since. The configuration is read under a URL naming the bytes
  // it was read from, so a run always evaluates the file it is generating from, and a run that
  // follows an unchanged file still costs nothing. Importing it reaches no environment, secret
  // or network by design, which is what makes reading it again safe.
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
