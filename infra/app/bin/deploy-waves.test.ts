import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../test/helpers.ts";

const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
const PACKAGE_DIR = new URL("..", import.meta.url).pathname;

function run(
  args: readonly string[],
): Promise<{ failed: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [TSX_CLI, "bin/deploy-waves.ts", ...args],
      { cwd: PACKAGE_DIR },
      (error, _stdout, stderr) => {
        resolve({ failed: error !== null, stderr });
      },
    );
  });
}

describe("bin/deploy-waves.ts", () => {
  // The deploy workflow reads these lines as job outputs, and each wave's job takes its matrix
  // from one.
  it("writes each wave as a GitHub output, its stacks space-separated", async () => {
    const [dev] = FIXTURE_STAGES;
    const output = join(mkdtempSync(join(tmpdir(), "deploy-waves-")), "output");

    const result = await run([synthesizedStage(dev).directory, output]);

    expect(result).toEqual({ failed: false, stderr: "" });
    expect(readFileSync(output, "utf8")).toBe(
      [
        `wave1=${JSON.stringify([
          {
            account: "100000000002",
            stacks:
              "frontdoor-sandbox-caller-token-keys frontdoor-sandbox-edge-logs-eu-west-2",
          },
          {
            account: "100000000003",
            stacks: "domainaccount-sandbox-main network-sandbox-main",
          },
        ])}`,
        `wave2=${JSON.stringify([
          {
            account: "100000000003",
            stacks:
              "domain-sandbox-domain-a domain-sandbox-domain-b gateway-sandbox-main-udp",
          },
        ])}`,
        `wave3=${JSON.stringify([
          { account: "100000000002", stacks: "frontdoor-sandbox" },
        ])}`,
        "",
      ].join("\n"),
    );
  });

  it("refuses to run without both arguments", async () => {
    const result = await run([]);

    expect(result.failed).toBe(true);
    expect(result.stderr).toContain("Usage: deploy-waves.ts");
  });
});
