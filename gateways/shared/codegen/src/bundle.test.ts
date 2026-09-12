import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import esbuild from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emitValidators } from "./emit-validators.ts";
import type { GatewaySchemas, Validator } from "./types.ts";

let tmp: string;

const schemas: GatewaySchemas = {
  defs: {
    UserRecord: {
      type: "object",
      properties: {
        id: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
      },
      required: ["id"],
    },
  },
  operations: {
    createUser: {
      input: {
        type: "object",
        properties: { email: { type: "string" } },
        required: ["email"],
        additionalProperties: false,
      },
      outcomes: {
        created: { $ref: "UserRecord" },
      },
    },
  },
};

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "codegen-bundle-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function buildBundle() {
  const validatorsDir = path.join(tmp, "validators");
  await emitValidators(schemas, validatorsDir);

  return esbuild.build({
    entryPoints: [path.join(validatorsDir, "index.js")],
    // No nodePaths. The emitted directory resolves entirely on its own; pointing esbuild at
    // codegen's node_modules would hide a package import that breaks in a real service.
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    metafile: true,
  });
}

describe("bundle verification", () => {
  it("bundles emitted modules without additional package dependencies", async () => {
    const result = await buildBundle();
    const inputs = Object.keys(result.metafile.inputs);

    const compilerInputs = inputs.filter((p) => p.includes("ajv/dist/compile"));
    expect(compilerInputs).toEqual([]);

    // This second bundle checks for additional dependencies. Its input list cannot inspect
    // dependencies already embedded in schemas.js during emission.
    expect(inputs.filter((p) => p.includes("node_modules"))).toEqual([]);
    expect(inputs.toSorted()).toEqual(
      inputs
        .filter((p) => p.endsWith("index.js") || p.endsWith("schemas.js"))
        .toSorted(),
    );
  });

  it("validators work from the bundle", async () => {
    const result = await buildBundle();
    const bundlePath = path.join(tmp, "bundle.mjs");
    const output = result.outputFiles[0];

    expect(output).toBeDefined();
    await writeFile(bundlePath, output!.text);

    const mod = (await import(pathToFileURL(bundlePath).href)) as {
      validators: {
        createUser: {
          input: Validator;
          outcomes: { created: Validator };
        };
      };
    };
    expect(mod.validators.createUser.input({ email: "a@b.com" })).toBe(true);
    expect(mod.validators.createUser.input({})).toBe(false);
    expect(mod.validators.createUser.outcomes.created({ id: "123" })).toBe(
      true,
    );
  });
});
