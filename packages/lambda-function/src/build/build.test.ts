import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { buildLambdaFunction, HANDLER } from "./build.ts";

// An entry that answers with the config the build wrote in.
function entry(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "lambda-function-"));
  const file = path.join(directory, "entry.ts");
  writeFileSync(
    file,
    "declare const CONFIG: unknown;\nexport const handler = () => CONFIG;\n",
  );
  return file;
}

describe("buildLambdaFunction", () => {
  it("bundles a CommonJS module whose handler holds the config", () => {
    const code = buildLambdaFunction({
      entry: entry(),
      define: { CONFIG: { name: "example" } },
    });

    const module = { exports: {} as { handler?: () => unknown } };
    runInNewContext(code, { module, exports: module.exports });

    expect(module.exports.handler?.()).toEqual({ name: "example" });
    expect(HANDLER).toBe("index.handler");
  });
});
