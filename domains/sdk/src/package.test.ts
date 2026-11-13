import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import client from "@govuk-once/flex-gateway-client/package.json" with { type: "json" };
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

const versionOf = (text: string) => text.split(".").map(Number);

describe("the package's peer range for the gateway client", () => {
  // A gateway's package admits its client and any later one of the same major, spelled out
  // because under 1.0.0 a caret admits only the same minor. A caret here would refuse the client
  // those packages ask for as soon as it had a new minor.
  it("admits the workspace's client and every later one of its major", () => {
    const range = manifest.peerDependencies["@govuk-once/flex-gateway-client"];
    const bounds = /^>=(\d+\.\d+\.\d+) <(\d+)\.0\.0$/.exec(range);
    expect(bounds).not.toBeNull();
    const [major = 0, minor = 0, patch = 0] = versionOf(client.version);
    const [fromMajor, fromMinor = 0, fromPatch = 0] = versionOf(
      bounds?.[1] ?? "",
    );
    expect(fromMajor).toBe(major);
    expect(
      fromMinor < minor || (fromMinor === minor && fromPatch <= patch),
    ).toBe(true);
    expect(Number(bounds?.[2])).toBe(major + 1);
  });
});

describe("the published package", () => {
  let dist: string;
  const read = (name: string) => readFile(path.join(dist, name), "utf-8");

  beforeAll(async () => {
    dist = await mkdtemp(path.join(os.tmpdir(), "domain-sdk-"));
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

  it("imports only its dependencies, its peers and Node's own modules", async () => {
    expect(imported(await read("index.js"))).toEqual([
      "@govuk-once/flex-gateway-client",
      "@govuk-once/flex-gateway-client/caller",
      "node:async_hooks",
      "pino",
    ]);
    // The declarations name the same modules, and nothing of the workspace.
    expect(imported(await read("index.d.ts"))).toEqual([
      "@govuk-once/flex-gateway-client",
      "@govuk-once/flex-gateway-client/caller",
      "node:async_hooks",
      "pino",
      "zod",
    ]);
  });

  it("has a manifest of its own", async () => {
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
      files: ["index.d.ts", "index.js"],
      sideEffects: false,
      dependencies: manifest.dependencies,
      peerDependencies: manifest.peerDependencies,
    });
  });
});
