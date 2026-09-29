import path from "node:path";

import esbuild from "esbuild";

import {
  BUNDLE_MODULE,
  CONFIG_MODULE,
  ENTRY_MODULE,
  VALIDATORS_DIR,
  VALIDATORS_MODULE,
} from "./layout.ts";
import { formatSource, HEADER, writeGenerated } from "./output.ts";

// What makes a gateway runnable. Nothing in it is specific to a driver or a transport: the
// driver arrives as part of the configuration and builds its own executor, and the validators
// are keyed by the configuration's operations, so this module is the same for every gateway.

const entryModule = (id: string) => `
// Entry point for gateway "${id}". The platform calls the handler; nothing else is exported.
import { createHandler, readUpstreamOptions } from "@repo/gateway-runtime";

import config from "${CONFIG_MODULE}";
import { meta, validators } from "./${VALIDATORS_DIR}/${VALIDATORS_MODULE}";

// Built while this module loads, which is the platform's initialisation phase: the operations
// compile and the driver retrieves and validates the gateway secret once, before any request
// rather than during the first one. UPSTREAM_TARGET and UPSTREAM_SECRET_ARN are read here and
// nowhere else.
const execute = await config.driver.createExecutor(config, readUpstreamOptions());
const gateway = createHandler(config, { validators, meta, execute });

// The deadline is all that varies per invocation, and the platform reports it.
export const handler = (event, context) =>
  gateway(event, {
    deadline: { remainingMs: () => context.getRemainingTimeInMillis() },
  });
`;

// Writes the entry point into the runtime directory, beside the validators it imports.
export async function emitEntry(
  gatewayId: string,
  runtimeDir: string,
): Promise<void> {
  await writeGenerated(
    runtimeDir,
    ENTRY_MODULE,
    await formatSource(entryModule(gatewayId), "babel"),
  );
}

// A bundled CommonJS dependency, pino among them, reaches Node's builtins through `require`,
// which an ES module does not have: esbuild leaves a shim that throws unless one is in scope,
// so the module would fail to load rather than fail a request. The bundle makes its own.
const BANNER = [
  HEADER.trimEnd(),
  'import { createRequire as __createRequire } from "node:module";',
  "const require = __createRequire(import.meta.url);",
].join("\n");

// The deployed artifact: the entry point, the configuration, the validators, the driver and the
// runtime in one module. Bundling here rather than at deployment means a gateway that cannot be
// bundled fails generation, where the cause is at hand.
export async function bundleEntry(runtime: string): Promise<void> {
  // Resolved here because this is a public entry point of its own, and esbuild takes an absolute
  // working directory.
  const runtimeDir = path.resolve(runtime);
  await esbuild.build({
    // esbuild names each module it bundles relative to this, and a run builds in a directory of
    // its own: without it the artifact would carry the name of the directory it was built in,
    // and two runs of the same gateway would differ.
    absWorkingDir: runtimeDir,
    entryPoints: [path.join(runtimeDir, ENTRY_MODULE)],
    outfile: path.join(runtimeDir, BUNDLE_MODULE),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    // esbuild's own report would print beside the error it throws, which carries the same
    // messages and reaches the CLI.
    logLevel: "silent",
    banner: { js: BANNER },
  });
}
