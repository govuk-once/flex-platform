import { describe, expect, it } from "vitest";

import * as codegen from "./index.ts";

// The package's public surface. A consumer imports the barrel, so a rename or a moved file that
// breaks it fails here rather than in whatever imports it next.
describe("@repo/gateway-codegen", () => {
  it("exports what the CLI and its callers use", () => {
    expect(Object.keys(codegen).toSorted()).toEqual([
      "CLIENT_DIR",
      "CONTRACT_MODULE",
      "GENERATED_DIR",
      "GatewayCheckError",
      "RUNTIME_DIR",
      "VALIDATORS_DIR",
      "checkGateway",
      "emitContract",
      "emitValidators",
      "generate",
      "loadConfig",
      "loadGatewaySchemas",
      "loadSchemas",
      "main",
    ]);
  });

  it("names the directories and files a generated gateway holds", () => {
    // Every segment of a generated path, the directory they are all under included: a caller
    // that can name the rest and not that one cannot build a path at all.
    expect([
      codegen.GENERATED_DIR,
      codegen.RUNTIME_DIR,
      codegen.VALIDATORS_DIR,
      codegen.CLIENT_DIR,
      codegen.CONTRACT_MODULE,
    ]).toEqual([".gen", "runtime", "validators", "client", "rpc.ts"]);
  });
});
