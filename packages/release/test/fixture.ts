import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RECORD_FILE } from "../src/record.ts";
import type { Source } from "../src/sources.ts";
import type { Workspace } from "../src/workspace.ts";

// A workspace with a client and an SDK versioned in their manifests, and two gateways whose
// packages are versioned from a schema number. A function stands in for each build script: the
// client's build copies its manifest's version, the SDK's links the client, and a gateway's takes
// the client's major and names the client's version in its peer range, as codegen does.

export const SOURCES: readonly Source[] = [
  {
    group: "Client",
    directories: ["client"],
    script: "build",
    output: "dist",
    versioning: "declared",
    finalAt: "merge",
  },
  {
    group: "Gateways",
    directories: ["gateways/*"],
    script: "codegen",
    output: ".gen/package",
    versioning: "derived",
    finalAt: "production",
  },
  {
    group: "SDKs",
    directories: ["sdk"],
    script: "build",
    output: "dist",
    versioning: "declared",
    finalAt: "merge",
  },
];

export const CLIENT = "@govuk-once/client";
export const SDK = "@govuk-once/sdk";
export const gateway = (id: string) => `@govuk-once/gateway-${id}`;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function manifestOf(
  root: string,
  dir: string,
): Promise<{ name: string; version: string }> {
  return JSON.parse(
    await readFile(path.join(root, dir, "package.json"), "utf-8"),
  ) as { name: string; version: string };
}

async function writeBuilt(dir: string, manifest: unknown, code: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), json(manifest));
  await writeFile(path.join(dir, "index.js"), code);
}

const source = (root: string, dir: string) =>
  readFile(path.join(root, dir, "src.js"), "utf-8");

async function build(root: string): Promise<void> {
  const client = await manifestOf(root, "client");
  await writeBuilt(
    path.join(root, "client", "dist"),
    { name: client.name, version: client.version },
    await source(root, "client"),
  );
  const sdk = await manifestOf(root, "sdk");
  await writeBuilt(
    path.join(root, "sdk", "dist"),
    {
      name: sdk.name,
      version: sdk.version,
      dependencies: { [CLIENT]: "workspace:^" },
    },
    await source(root, "sdk"),
  );
  for (const id of ["a", "b"]) {
    const dir = path.join(root, "gateways", id);
    const schema = (await readFile(path.join(dir, "schema"), "utf-8")).trim();
    const major = Number(client.version.split(".")[0]);
    await writeBuilt(
      path.join(dir, ".gen", "package"),
      {
        name: gateway(id),
        version: `${major}.${schema}.0`,
        peerDependencies: { [CLIENT]: `>=${client.version} <${major + 1}.0.0` },
      },
      await source(root, `gateways/${id}`),
    );
  }
}

export async function setFile(
  root: string,
  file: string,
  text: string,
): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

export async function fixtureWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(path.join(tmpdir(), "release-fixture-"));
  await setFile(
    root,
    "package.json",
    json({
      name: "fixture",
      private: true,
      repository: { type: "git", url: "https://example.com/fixture.git" },
    }),
  );
  await setFile(root, "pnpm-workspace.yaml", "packages: []\n");
  await setFile(root, RECORD_FILE, "{}\n");
  await setFile(
    root,
    "client/package.json",
    json({ name: CLIENT, version: "0.1.0" }),
  );
  await setFile(root, "client/src.js", "export const client = 1;\n");
  await setFile(
    root,
    "sdk/package.json",
    json({ name: SDK, version: "0.1.0" }),
  );
  await setFile(root, "sdk/src.js", "export const sdk = 1;\n");
  for (const id of ["a", "b"]) {
    await setFile(
      root,
      `gateways/${id}/package.json`,
      json({ name: `@repo/${id}` }),
    );
    await setFile(root, `gateways/${id}/schema`, "1\n");
    await setFile(root, `gateways/${id}/src.js`, `export const ${id} = 1;\n`);
  }
  return {
    root,
    sources: SOURCES,
    build,
  };
}

export async function readJson(root: string, file: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(root, file), "utf-8"));
}
