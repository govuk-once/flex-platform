import path from "node:path";

import { checkGateway } from "./check-gateway.ts";
import { compileValidators, writeValidators } from "./emit-validators.ts";
import { loadConfig, loadGatewaySchemas } from "./load-config.ts";

async function main(): Promise<void> {
  const gatewayDir = process.cwd();

  const config = await loadConfig(gatewayDir);
  const schemas = await loadGatewaySchemas(config, gatewayDir);
  // The schemas are generated from before they are read against the configuration, so a schema
  // that is not a valid schema is reported as itself rather than as the disagreement it causes.
  const compiled = compileValidators(schemas);
  // Nothing is emitted for a configuration that disagrees with its schemas.
  checkGateway(config, schemas);

  await writeValidators(compiled, path.join(gatewayDir, ".gen", "validators"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
