import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { rolldown } from "rolldown";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import manifest from "../package.json" with { type: "json" };
import config from "../rolldown.config.ts";

// What a package's module or declarations import, a bare import included, sorted.
const imported = (source: string) =>
  [
    ...source.matchAll(
      /^\s*(?:import|export)\b(?:[^;"]*?\bfrom)?\s*"([^"]+)"/gm,
    ),
  ]
    .map((match) => match[1] ?? "")
    .toSorted();

describe("the published package", () => {
  let dist: string;
  const read = (name: string) => readFile(path.join(dist, name), "utf-8");

  beforeAll(async () => {
    dist = await mkdtemp(path.join(os.tmpdir(), "gateway-client-"));
    const { output, ...input } = config;
    const build = await rolldown(input);
    try {
      await build.write({ ...(output as object), dir: dist });
    } finally {
      await build.close();
    }
  }, 60_000);

  afterAll(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  it("imports only its peers", async () => {
    expect(imported(await read("index.js"))).toEqual([
      "./context.js",
      "@aws-sdk/client-lambda",
    ]);
    expect(imported(await read("index.d.ts"))).toEqual([
      "@aws-sdk/client-lambda",
    ]);
  });

  it("holds one caller context, which both entries share", async () => {
    expect(imported(await read("caller.js"))).toEqual(["./context.js"]);
    expect(imported(await read("context.js"))).toEqual(["node:async_hooks"]);
    expect(imported(await read("caller.d.ts"))).toEqual([]);
  });

  it("has a manifest of its own, with no dependencies", async () => {
    const published = JSON.parse(await read("package.json")) as Record<
      string,
      unknown
    >;
    expect(published).toEqual({
      name: "@govuk-once/flex-gateway-client",
      version: manifest.version,
      description: manifest.description,
      type: "module",
      exports: {
        ".": { types: "./index.d.ts", default: "./index.js" },
        "./caller": { types: "./caller.d.ts", default: "./caller.js" },
      },
      files: [
        "caller.d.ts",
        "caller.js",
        "context.js",
        "index.d.ts",
        "index.js",
      ],
      sideEffects: false,
      peerDependencies: manifest.peerDependencies,
    });
  });
});
