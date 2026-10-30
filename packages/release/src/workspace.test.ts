import { rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLIENT,
  fixtureWorkspace,
  gateway,
  SDK,
  setFile,
} from "../test/fixture.ts";
import {
  buildWorkspace,
  dependencyOrder,
  type Publishable,
  readManifest,
  repositoryOf,
  sourceDirectories,
  type Workspace,
} from "./workspace.ts";

let workspace: Workspace;

beforeEach(async () => {
  workspace = await fixtureWorkspace();
});

afterEach(async () => {
  await rm(workspace.root, { recursive: true, force: true });
});

describe("the workspace's packages", () => {
  it("are found in each source's directories, in order", () => {
    expect(sourceDirectories(workspace.root, workspace.sources[1]!)).toEqual([
      "gateways/a",
      "gateways/b",
    ]);
  });

  it("are read as their builds wrote them", async () => {
    const pkgs = await buildWorkspace(workspace);

    expect(pkgs.map((pkg) => [pkg.directory, pkg.built.name])).toEqual([
      ["client", CLIENT],
      ["gateways/a", gateway("a")],
      ["gateways/b", gateway("b")],
      ["sdk", SDK],
    ]);
  });

  it("refuses a declared package whose build is not itself", async () => {
    const build = workspace.build!;
    const stale: Workspace = {
      ...workspace,
      build: async (root, sources) => {
        await build(root, sources);
        await setFile(
          root,
          "client/package.json",
          '{ "name": "@govuk-once/client", "version": "0.9.0" }',
        );
      },
    };

    await expect(buildWorkspace(stale)).rejects.toThrow(
      "client builds @govuk-once/client@0.1.0, not itself, @govuk-once/client@0.9.0.",
    );
  });

  it("refuses a package outside the scope, or built by more than one directory", async () => {
    await setFile(
      workspace.root,
      "client/package.json",
      '{ "name": "@repo/client", "version": "0.1.0" }',
    );
    await expect(buildWorkspace(workspace)).rejects.toThrow(
      "client builds @repo/client, which is not in @govuk-once/.",
    );

    await setFile(
      workspace.root,
      "client/package.json",
      `{ "name": "${gateway("a")}", "version": "0.1.0" }`,
    );
    await expect(buildWorkspace(workspace)).rejects.toThrow(
      `More than one directory builds ${gateway("a")}.`,
    );
  });

  it("refuses a directory whose build wrote no package", async () => {
    await setFile(
      workspace.root,
      "gateways/c/package.json",
      '{ "name": "@repo/c" }',
    );

    await expect(buildWorkspace(workspace)).rejects.toThrow(
      "gateways/c has no package in .gen/package/ after its codegen script.",
    );
  });

  it("refuses a manifest that names no package and version", async () => {
    await setFile(workspace.root, "sdk/package.json", `{ "name": "${SDK}" }`);

    await expect(
      readManifest(`${workspace.root}/sdk/package.json`),
    ).rejects.toThrow("sdk/package.json names no package and version.");
  });

  it("are published from the repository the workspace names, and refused without one", async () => {
    expect(await repositoryOf(workspace.root)).toEqual({
      type: "git",
      url: "https://example.com/fixture.git",
    });

    await setFile(workspace.root, "package.json", '{ "name": "fixture" }');
    await expect(repositoryOf(workspace.root)).rejects.toThrow(
      "The workspace's package.json names no repository.",
    );
  });
});

describe("dependencyOrder", () => {
  const pkg = (
    name: string,
    peers: Record<string, string> = {},
  ): Publishable => ({
    source: {
      group: "",
      directories: [],
      script: "",
      output: "",
      versioning: "declared",
      finalAt: "merge",
    },
    directory: name,
    builtDir: name,
    built: { name, version: "0.1.0", peerDependencies: peers },
  });

  it("puts each package after the ones it depends on", () => {
    const ordered = dependencyOrder([
      pkg("a", { c: "1.0.0" }),
      pkg("b"),
      pkg("c", { b: "1.0.0" }),
    ]);

    expect(ordered.map((p) => p.built.name)).toEqual(["b", "c", "a"]);
  });

  it("refuses a cycle", () => {
    expect(() =>
      dependencyOrder([pkg("a", { b: "1.0.0" }), pkg("b", { a: "1.0.0" })]),
    ).toThrow("depends on itself.");
  });
});
