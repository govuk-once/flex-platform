import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setFile } from "../test/fixture.ts";
import { contentDigest, packPackage } from "./package.ts";

let dir: string;
const built = () => path.join(dir, "built");

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "release-package-"));
  await setFile(dir, "built/index.js", "export {};\n");
  await setFile(dir, "built/types/index.d.ts", "export {};\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const manifest = (fields: Record<string, unknown> = {}) => ({
  name: "@govuk-once/x",
  version: "0.1.0",
  ...fields,
});

describe("contentDigest", () => {
  it("is the same whatever the manifest's version, or the order of its fields", async () => {
    const digest = await contentDigest(built(), manifest());

    expect(await contentDigest(built(), manifest({ version: "0.2.0" }))).toBe(
      digest,
    );
    expect(
      await contentDigest(built(), { version: "0.1.0", name: "@govuk-once/x" }),
    ).toBe(digest);
  });

  it("changes with any file, however deep, or the rest of the manifest", async () => {
    const digest = await contentDigest(built(), manifest());

    expect(await contentDigest(built(), manifest({ type: "module" }))).not.toBe(
      digest,
    );
    await setFile(dir, "built/types/index.d.ts", "export type X = 1;\n");
    expect(await contentDigest(built(), manifest())).not.toBe(digest);
  });
});

describe("packPackage", () => {
  const tar = (...args: string[]) =>
    promisify(execFileCb)("tar", args).then(({ stdout }) => stdout);

  it("packs every built file under package/, with the manifest it is given in place of the built one", async () => {
    const file = path.join(dir, "x.tgz");
    await setFile(
      dir,
      "built/package.json",
      '{ "name": "built", "version": "0.0.0" }',
    );

    await packPackage(built(), manifest({ version: "0.3.0" }), file);

    // tar checks each header's checksum as it reads it.
    expect((await tar("-tzf", file)).split("\n").filter(Boolean)).toEqual([
      "package/index.js",
      "package/package.json",
      "package/types/index.d.ts",
    ]);
    expect(
      JSON.parse(await tar("-xzOf", file, "package/package.json")),
    ).toEqual(manifest({ version: "0.3.0" }));
    expect(await tar("-xzOf", file, "package/types/index.d.ts")).toBe(
      "export {};\n",
    );
  });

  it("packs a path longer than a header's name holds", async () => {
    const deep = `${"directory/".repeat(12)}index.js`;
    await setFile(dir, `built/${deep}`, "export const deep = 1;\n");
    const file = path.join(dir, "x.tgz");

    await packPackage(built(), manifest(), file);

    expect(await tar("-xzOf", file, `package/${deep}`)).toBe(
      "export const deep = 1;\n",
    );
  });
});
