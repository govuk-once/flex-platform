import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  DriverDefinition,
  GatewayConfig,
  OperationConfig,
} from "@repo/gateway-config";
import { sortedNames } from "@repo/utils/sorted-names";

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

// What a gateway is generated from: its own modules, not what they resolve to in a package.
// Generated output and anything installed is left out, and so is every dotted entry, which is
// where a run stages what it is building.
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
]);

async function sourceFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await sourceFiles(path.join(dir, entry.name), relative)));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(relative);
    }
  }
  return found;
}

// Everything the gateway's own modules are made of, as one name, for a caller that needs to know
// whether any of them changed while it worked.
export async function sourceDigest(gatewayDir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of sortedNames(await sourceFiles(gatewayDir))) {
    hash.update(file);
    hash.update(await readFile(path.join(gatewayDir, file)));
  }
  return hash.digest("hex").slice(0, 32);
}

// Loads TypeScript via Node's type stripping without a config compilation step. Importing a
// configuration reaches no environment, secret or network by design, so this runs anywhere.
export async function loadConfig(
  gatewayDir: string,
): Promise<AnyGatewayConfig> {
  return loadModule<AnyGatewayConfig>(path.resolve(gatewayDir, CONFIG_FILE));
}
