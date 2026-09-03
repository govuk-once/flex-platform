#!/usr/bin/env node

import path from "node:path";

import { emitValidators } from "./emit-validators.ts";
import { loadSchemas } from "./load-config.ts";

async function main(): Promise<void> {
  const gatewayDir = process.cwd();

  // const config = await loadConfig(gatewayDir);
  const schemas = await loadSchemas(gatewayDir);
  const outDir = path.join(gatewayDir, ".gen", "validators");
  await emitValidators(schemas, outDir);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
