import { describe, expect, it } from "vitest";

import * as codegen from "./index.ts";

// The package's public surface. A consumer imports the barrel, so a rename or a moved file that
// breaks it fails here rather than in whatever imports it next.
describe("@repo/gateway-codegen", () => {
  it("exports what the CLI and its callers use", () => {
    expect(Object.keys(codegen).toSorted()).toEqual([
      "GatewayCheckError",
      "checkGateway",
      "emitValidators",
      "loadConfig",
      "loadGatewaySchemas",
      "loadSchemas",
      "main",
    ]);
  });

  it("exports them as functions", () => {
    for (const [name, value] of Object.entries(codegen)) {
      expect(typeof value, name).toBe("function");
    }
  });
});
