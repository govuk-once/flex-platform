import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { buildKeyRotationFunction } from "./build.ts";

const execFile = promisify(execFileCb);

const CONFIG = {
  keyAlias: "alias/frontdoor-sandbox-caller-token",
  signingKeyParameter: "/flex/frontdoor/sandbox/caller-token-signing-key",
  stateParameter: "/flex/frontdoor/sandbox/caller-token-key-state",
  publicKeysBucket: "frontdoor-sandbox-keys-100000000002",
  publicKeysAccount: "100000000002",
  publicKeysObject: "caller-token-keys.json",
  publicKeysRegion: "eu-west-2",
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
});
