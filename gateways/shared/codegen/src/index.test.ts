import { describe, expect, it } from "vitest";

import * as codegen from "./index.ts";

// The package's public surface. A consumer imports the barrel, so a rename or a moved file that
// breaks it fails here rather than in whatever imports it next.
describe("@repo/gateway-codegen", () => {
  it("exports what the CLI and its callers use", () => {
    expect(Object.keys(codegen).toSorted()).toEqual([
      "BUNDLE_MODULE",
      "CLIENT_DIR",
      "CONTRACT_MODULE",
      "ENTRY_MODULE",
      "GatewayCheckError",
      "RUNTIME_DIR",
      "VALIDATORS_DIR",
      "bundleEntry",
      "checkGateway",
      "emitContract",
      "emitEntry",
      "emitValidators",
      "generate",
      "loadConfig",
      "loadGatewaySchemas",
      "loadSchemas",
      "main",
    ]);
  });

  it("names the directories and files a generated gateway holds", () => {
    expect([
      codegen.RUNTIME_DIR,
      codegen.VALIDATORS_DIR,
      codegen.ENTRY_MODULE,
      codegen.BUNDLE_MODULE,
      codegen.CLIENT_DIR,
      codegen.CONTRACT_MODULE,
    ]).toEqual([
      "runtime",
      "validators",
      "entry.js",
      "bundle.mjs",
      "client",
      "rpc.ts",
    ]);
  });
});
