import { buildSync } from "esbuild";

import type { KeyRotationConfig } from "../function/types.ts";

const ENTRY = new URL("../function/entry.ts", import.meta.url).pathname;

// The bundle is CommonJS, deployed as `index.js` with the handler `index.handler`.
export const HANDLER = "index.handler";

// Synchronous, because CDK builds constructs synchronously. Returns the code of `index.js`, with
// every dependency bundled, the AWS SDK's included, so the function runs the versions tested
// here, and the config baked in.
export function buildKeyRotationFunction(config: KeyRotationConfig): string {
  const result = buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node24",
    define: { KEY_ROTATION_CONFIG: JSON.stringify(config) },
  });

  const output = result.outputFiles[0]?.text;
  if (output === undefined) throw new Error("esbuild produced no output");
  return output;
}
