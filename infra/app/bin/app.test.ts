import { execFile } from "node:child_process";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

// Runs the entry point the way cdk.json does, so a broken import or wiring in bin/app.ts fails
// here rather than only under the CDK CLI.
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
const PACKAGE_DIR = new URL("..", import.meta.url).pathname;

interface Run {
  readonly failed: boolean;
  readonly stderr: string;
}

function runEntryPoint(context: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [TSX_CLI, "bin/app.ts"],
      {
        cwd: PACKAGE_DIR,
        env: { ...process.env, CDK_CONTEXT_JSON: JSON.stringify(context) },
      },
      (error, _stdout, stderr) => {
        resolve({ failed: error !== null, stderr });
      },
    );
  });
}

describe("bin/app.ts", () => {
  it("refuses to build without a stage", async () => {
    const run = await runEntryPoint({});

    expect(run.failed).toBe(true);
    expect(run.stderr).toContain(
      "Pass the stage to build with -c stage=<name>",
    );
  });

  it("refuses a stage the config doesn't have", async () => {
    const run = await runEntryPoint({ stage: "platform-qa" });

    expect(run.failed).toBe(true);
    expect(run.stderr).toContain('Unknown stage "platform-qa"');
  });
});
