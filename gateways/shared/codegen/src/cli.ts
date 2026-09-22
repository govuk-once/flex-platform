import path from "node:path";

import { checkGateway } from "./check-gateway.ts";
import { compileValidators, writeValidators } from "./emit-validators.ts";
import { loadConfig, loadGatewaySchemas } from "./load-config.ts";

// What the command does in a gateway package: read its configuration and the schemas that go
// with it, check the two against each other, and write what it generates. Exported and free of
// side effects, so the command is exercised here rather than only as a process; the process
// itself, which is the exit code and nothing else, is the bin script.
export async function main(gatewayDir: string = process.cwd()): Promise<void> {
  const config = await loadConfig(gatewayDir);
  const schemas = await loadGatewaySchemas(config, gatewayDir);
  // The schemas are generated from before they are read against the configuration, so a schema
  // that is not a valid schema is reported as itself rather than as the disagreement it causes.
  const compiled = compileValidators(schemas);
  // Nothing is emitted for a configuration that disagrees with its schemas.
  checkGateway(config, schemas);

  await writeValidators(compiled, path.join(gatewayDir, ".gen", "validators"));
}
