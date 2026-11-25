import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { KeyRotationConfig } from "../function/types.ts";
import { buildKeyRotationFunction } from "./build.ts";

const execFile = promisify(execFileCb);

const CONFIG: KeyRotationConfig = {
  kind: "caller-token",
  keyAlias: "alias/frontdoor-sandbox-caller-token",
  privateKeysTable: "frontdoor-sandbox-caller-token-private-keys",
  publicKeysTable: "frontdoor-sandbox-caller-token-public-keys",
  publication: {
    bucket: "frontdoor-sandbox-keys-100000000002",
    account: "100000000002",
    object: "caller-token-keys.json",
    region: "eu-west-2",
  },
};

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("buildKeyRotationFunction", () => {
  it("bakes in the config", () => {
    expect(buildKeyRotationFunction(CONFIG)).toContain(
      "frontdoor-sandbox-keys-100000000002",
    );
  });

  // As Lambda loads it: `index.js` alone, outside the workspace, so nothing it needs can be
  // resolved from the repository.
  it("loads with nothing beside it, and exports its handler", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "key-rotation-"));
    directories.push(directory);
    writeFileSync(
      path.join(directory, "index.js"),
      buildKeyRotationFunction(CONFIG),
    );

    const { stdout } = await execFile(
      process.execPath,
      ["-e", 'process.stdout.write(typeof require("./index.js").handler)'],
      { cwd: directory, env: { AWS_REGION: "eu-west-2" } },
    );
    expect(stdout).toBe("function");
  });

  it("refuses a kind with no policy", () => {
    expect(() =>
      buildKeyRotationFunction({
        ...CONFIG,
        kind: "nothing" as KeyRotationConfig["kind"],
      }),
    ).toThrow('No key policy is named "nothing"');
  });

  it("refuses a publication the kind's policy doesn't make", () => {
    expect(() =>
      buildKeyRotationFunction({ ...CONFIG, publication: null }),
    ).toThrow("The caller-token keys' policy and config disagree");
  });
});
