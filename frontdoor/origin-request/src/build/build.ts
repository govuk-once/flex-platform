import { buildSync } from "esbuild";

import type { OriginRequestConfig } from "../function/types.ts";

const ENTRY = new URL("../function/entry.ts", import.meta.url).pathname;

// The bundle is CommonJS, deployed as `index.js` with the handler `index.handler`.
export const HANDLER = "index.handler";

// Synchronous, because CDK builds constructs synchronously. Returns the code of `index.js`, with
// every dependency bundled and the config baked in.
export function buildOriginRequestFunction(
  config: OriginRequestConfig,
): string {
  const result = buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node24",
    define: { ORIGIN_REQUEST_CONFIG: JSON.stringify(config) },
    // Not minified, so the source locations a failure logs point at a line worth reading.
  });

  const output = result.outputFiles[0]?.text;
  if (output === undefined) throw new Error("esbuild produced no output");
  return output;
}
