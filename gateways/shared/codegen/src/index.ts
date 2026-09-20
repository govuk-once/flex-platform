export { checkGateway, GatewayCheckError } from "./check-gateway.ts";
export { main } from "./cli.ts";
export type { SchemaComparison } from "./compare-schemas.ts";
export { compareSchemas, SchemaCompatibilityError } from "./compare-schemas.ts";
export { emitContract } from "./emit-contract.ts";
export { bundleEntry, emitEntry } from "./emit-entry.ts";
export { emitValidators } from "./emit-validators.ts";
export { generate } from "./generate.ts";
export {
  BUNDLE_MODULE,
  CLIENT_DIR,
  CONTRACT_MODULE,
  ENTRY_MODULE,
  GENERATED_DIR,
  RUNTIME_DIR,
  VALIDATORS_DIR,
} from "./layout.ts";
export type { AnyGatewayConfig } from "./load-config.ts";
export { loadConfig } from "./load-config.ts";
export { loadSchemas, SchemaStoreError } from "./schema-store.ts";
