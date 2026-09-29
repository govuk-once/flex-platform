import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bundleEntry, emitEntry } from "./emit-entry.ts";
import { ENTRY_MODULE, VALIDATORS_DIR } from "./layout.ts";

let tmp: string;
let entry: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "emit-entry-"));
  await emitEntry("udp", tmp);
  entry = await readFile(path.join(tmp, ENTRY_MODULE), "utf-8");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("emitted entry point", () => {
  it("writes one module and nothing else", async () => {
    expect(await readdir(tmp)).toEqual([ENTRY_MODULE]);
  });

  it("carries a do-not-edit header naming the gateway", () => {
    expect(entry.startsWith("// GENERATED FILE.")).toBe(true);
    expect(entry).toContain('gateway "udp"');
  });

  it("wires the configuration, the validators and the driver's executor", () => {
    expect(entry).toContain(
      'import { createHandler, readUpstreamOptions } from "@repo/gateway-runtime";',
    );
    expect(entry).toContain('import config from "../../gateway.config.ts";');
    expect(entry).toContain(
      `import { meta, validators } from "./${VALIDATORS_DIR}/index.js";`,
    );
    expect(entry).toContain(
      "config.driver.createExecutor(config, readUpstreamOptions())",
    );
    expect(entry).toContain(
      "createHandler(config, { validators, meta, execute })",
    );
  });

  it("names no driver or transport", () => {
    // The driver arrives as part of the configuration, so one entry point suits every gateway.
    expect(entry).not.toMatch(/openapi|http|fetch/i);
  });

  it("builds the handler as the module loads, not per invocation", () => {
    // The environment is read and the secret retrieved during initialisation; an invocation
    // supplies only its deadline.
    expect(entry).toContain(
      "const execute = await config.driver.createExecutor",
    );
    expect(entry).toContain("context.getRemainingTimeInMillis()");
    expect(entry).toMatch(/export const handler = \(event, context\) =>/);
  });

  it("exports the handler and nothing else", () => {
    // The platform calls the handler; a gateway has no other caller.
    expect([...entry.matchAll(/^export\b/gm)]).toHaveLength(1);
  });

  it("emits a module esbuild accepts for the deployed target", async () => {
    const built = await esbuild.transform(entry, {
      loader: "js",
      format: "esm",
      platform: "node",
      target: "node24",
    });
    expect(built.warnings).toEqual([]);
  });
});

describe("bundleEntry", () => {
  it("fails when the entry point's imports do not resolve", async () => {
    // The gateway a bundle is built from is what makes its imports resolvable; a temporary
    // directory has neither the configuration nor the runtime. Bundling at generation is what
    // turns that into a failure the author sees rather than a deployment that does not start.
    await expect(bundleEntry(tmp)).rejects.toThrow(/Could not resolve/);
  });
});
