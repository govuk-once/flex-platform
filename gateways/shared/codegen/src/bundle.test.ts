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
    nodePaths: [path.resolve(import.meta.dirname, "../node_modules")],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    metafile: true,
  });
}

describe("bundle verification", () => {
  it("excludes the ajv compiler and inlines ajv-formats", async () => {
    const result = await buildBundle();
    const inputs = Object.keys(result.metafile.inputs);

    const compilerInputs = inputs.filter((p) => p.includes("ajv/dist/compile"));
    expect(compilerInputs).toEqual([]);

    const formatInputs = inputs.filter((p) =>
      p.includes("ajv-formats/dist/formats"),
    );
    expect(formatInputs.length).toBeGreaterThan(0);
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
