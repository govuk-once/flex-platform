import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { rolldown } from "rolldown";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import manifest from "../package.json" with { type: "json" };
import config from "../rolldown.config.ts";

const ENTRIES = ["index"];

// What a module or declarations file imports, a bare import included.
const imported = (source: string) =>
  [
    ...source.matchAll(
      /^\s*(?:import|export)\b(?:[^;"]*?\bfrom)?\s*"([^"]+)"/gm,
    ),
  ].map((match) => match[1] ?? "");

describe("the published package", () => {
  let dist: string;

  const read = (name: string) => readFile(path.join(dist, name), "utf-8");

  let files: readonly string[];

  beforeAll(async () => {
    dist = await mkdtemp(path.join(os.tmpdir(), "domain-sdk-"));

    const { output, ...input } = config;

    const build = await rolldown(input);

    try {
      const written = await build.write({ ...(output as object), dir: dist });

      files = written.output.map(({ fileName }) => fileName);
    } finally {
      await build.close();
    }
  }, 60_000);

  afterAll(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  it("imports only its dependencies, its peers, Node's own modules and its own chunks", async () => {
    const packages = [
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.peerDependencies),
    ];

    for (const file of files.filter((name) => name.endsWith(".js"))) {
      for (const name of imported(await read(file))) {
        const allowed =
          name.startsWith("./") ||
          name.startsWith("node:") ||
          packages.some((pkg) => name === pkg || name.startsWith(`${pkg}/`));

        expect(allowed, `${file} imports ${name}`).toBe(true);
      }
    }
  });

  it("has a manifest of its own, with its entry", async () => {
    const published = JSON.parse(await read("package.json")) as Record<
      string,
      unknown
    >;

    expect(published).toEqual({
      name: "@govuk-once/flex-domain-sdk",
      version: manifest.version,
      description: manifest.description,
      type: "module",
      exports: {
        ".": { types: "./index.d.ts", default: "./index.js" },
      },
      files: expect.arrayContaining(
        ENTRIES.flatMap((entry) => [`${entry}.js`, `${entry}.d.ts`]),
      ) as string[],
      sideEffects: false,
      dependencies: manifest.dependencies,
      peerDependencies: manifest.peerDependencies,
    });
  });
});
