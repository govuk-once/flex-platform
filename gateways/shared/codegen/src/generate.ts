import path from "node:path";

import { checkGateway } from "./check-gateway.ts";
import { emitContract } from "./emit-contract.ts";
import { compileValidators, writeValidators } from "./emit-validators.ts";
import {
  CLIENT_DIR,
  GENERATED_DIR,
  RUNTIME_DIR,
  VALIDATORS_DIR,
} from "./layout.ts";
import { loadConfig, loadGatewaySchemas } from "./load-config.ts";

// One generated directory per gateway, holding the two things a gateway produces: what it runs
// and what a caller imports. A gateway is named by its directory rather than by a configuration
// object: the configuration and its schemas are read here, from the bytes on disk rather than
// from whatever a process loaded before, so what is checked is what the gateway says now.
// Checked first, so a configuration that disagrees with its schemas produces no output at all
// rather than output that fails later.
export async function generate(gatewayDir: string): Promise<void> {
  const dir = path.resolve(gatewayDir);
  const config = await loadConfig(dir);
  const schemas = await loadGatewaySchemas(config, dir);

  // The schemas are generated from before they are read against the configuration, so a schema
  // that is not a valid schema is reported as itself rather than as the disagreement it causes.
  const compiled = compileValidators(schemas);
  checkGateway(config, schemas);

  const outDir = path.join(dir, GENERATED_DIR);
  await writeValidators(
    compiled,
    path.join(outDir, RUNTIME_DIR, VALIDATORS_DIR),
  );
  await emitContract(config.id, schemas, path.join(outDir, CLIENT_DIR));
}
