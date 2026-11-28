import { describe, expect, it } from "vitest";

import * as codegen from "./index.ts";
import * as layout from "./layout.ts";

// The package's public surface. A consumer imports the barrel, so a rename or a moved file that
// breaks it fails here rather than in whatever imports it next.
describe("@repo/gateway-codegen", () => {
  it("exports what the CLI and its callers use", () => {
    expect(Object.keys(codegen).toSorted()).toEqual([
      "COMPOSITION",
      "CONTAINS_BOUNDS",
      "ProblemsError",
      "SUBSCHEMAS",
      "SUBSCHEMA_LISTS",
      "SUBSCHEMA_MAPS",
      "checkValue",
      "emitValidators",
    ]);
  });

  it("names the directories and files a generated gateway holds", () => {
    // Every segment of a generated path, the directory they are all under included: a caller
    // that can name the rest and not that one cannot build a path at all.
    expect([
      layout.GENERATED_DIR,
      layout.RUNTIME_DIR,
      layout.VALIDATORS_DIR,
      layout.ENTRY_MODULE,
      layout.BUNDLE_MODULE,
      layout.CLIENT_DIR,
      layout.CONTRACT_MODULE,
    ]).toEqual([
      ".gen",
      "runtime",
      "validators",
      "entry.js",
      "bundle.mjs",
      "client",
      "rpc.ts",
    ]);
  });
});
