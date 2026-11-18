import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { CONFIG, REQUEST, TARGET } from "../../test/helpers.ts";
import type { ReleaseConfig, ReleaseTarget } from "../worker/types.ts";
import {
  buildDeadLetterWorker,
  buildReleaseWorker,
  RELEASE_HANDLER,
} from "./build.ts";

const execFile = promisify(execFileCb);

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Runs the bundle as Lambda would: `index.js` alone in a directory outside the workspace, so
// nothing it needs can be resolved from the repository, loaded as CommonJS by a fresh Node.
async function invoke(code: string, bodies: readonly string[]) {
  const directory = mkdtempSync(path.join(tmpdir(), "release-worker-"));
  directories.push(directory);
  writeFileSync(path.join(directory, "index.js"), code);
  const script = `
    const logs = [];
    console.log = (line) => logs.push(JSON.parse(line));
    const { handler } = require("./index.js");
    (async () => {
      const responses = [];
      for (const [index, body] of JSON.parse(process.argv[1]).entries()) {
        responses.push(await handler({ Records: [{ messageId: String(index), body }] }));
      }
      process.stdout.write(JSON.stringify({ responses, logs }));
    })();
  `;
  const { stdout } = await execFile(
    process.execPath,
    ["-e", script, JSON.stringify(bodies)],
    { cwd: directory, env: { AWS_REGION: "eu-west-2" } },
  );
  return JSON.parse(stdout) as { responses: unknown[]; logs: unknown[] };
}

describe("buildReleaseWorker", () => {
  it("is deployed as index.js, with its handler exported by that name", () => {
    expect(RELEASE_HANDLER).toBe("index.handler");
  });

  it("needs nothing but Node's builtins", () => {
    const code = buildReleaseWorker(CONFIG);

    const required = [
      ...code.matchAll(/(?<=^|[\s=(,;])require\("([^"]+)"\)/gm),
    ].map(([, name]) => name);
    expect(required.length).toBeGreaterThan(0);
    for (const name of required) {
      expect(builtinModules).toContain(name?.replace(/^node:/, ""));
    }
  });

  // A message that names a release would go to the table, which the bundle can't reach here.
  it("runs on its own, refusing a message before it reaches AWS", async () => {
    const { responses, logs } = await invoke(buildReleaseWorker(CONFIG), [
      "SYNTHETIC text",
      JSON.stringify({ ...REQUEST, id: "1" }),
    ]);

    expect(responses).toEqual([
      { batchItemFailures: [] },
      { batchItemFailures: [] },
    ]);
    expect(logs).toEqual([
      expect.objectContaining({
        telemetry: expect.objectContaining({
          event: "release_invalid",
        }) as unknown,
      }),
      expect.objectContaining({
        telemetry: expect.objectContaining({
          event: "release_invalid",
        }) as unknown,
      }),
    ]);
  });

  it("bakes in the config it was built with", () => {
    const code = buildReleaseWorker(CONFIG);

    expect(code).toContain(`table: "${CONFIG.table}"`);
    expect(code).toContain(`deployRoleArn: "${TARGET.deployRoleArn}"`);
  });

  it.each<[string, Partial<ReleaseConfig>, string]>([
    ["a bucket whose name S3 can't hold", { bucket: "Shared_Code" }, "bucket"],
    ["no region", { region: "" }, "bucket"],
    ["a target listed twice", { targets: [TARGET, TARGET] }, "listed twice"],
    [
      "a table given by its ARN",
      {
        table: "arn:aws:dynamodb:eu-west-2:000000000000:table/shared-releases",
      },
      "table",
    ],
  ])("refuses to build with %s", (_, change, message) => {
    expect(() => buildReleaseWorker({ ...CONFIG, ...change })).toThrow(message);
  });

  it.each<[string, Partial<ReleaseTarget>, string]>([
    [
      "an environment that isn't a name",
      { environment: "Development" },
      "name",
    ],
    ["a domain that isn't a name", { domain: "a/b" }, "name"],
    [
      "a deploy role given by name",
      { deployRoleArn: "domain-development-example-deploy" },
      "deploy role",
    ],
    [
      "an execution role in no account",
      {
        executionRoleArn:
          "arn:aws:iam:::role/domain-development-example-execution",
      },
      "execution role",
    ],
    [
      "a function given by ARN",
      {
        functionName:
          "arn:aws:lambda:eu-west-2:200000000001:function:domain-development-example",
      },
      "function",
    ],
    ["a log group that isn't a path", { logGroupName: "function" }, "path"],
    [
      "a parameter that isn't a path",
      { subnetIdsParameter: "/flex/network//subnets" },
      "path",
    ],
  ])("refuses a target with %s", (_, change, message) => {
    expect(() =>
      buildReleaseWorker({ ...CONFIG, targets: [{ ...TARGET, ...change }] }),
    ).toThrow(message);
  });
});

describe("buildDeadLetterWorker", () => {
  const DEAD_LETTER_CONFIG = { region: "eu-west-2", table: "shared-releases" };

  it("needs nothing but Node's builtins, and bakes in its table", () => {
    const code = buildDeadLetterWorker(DEAD_LETTER_CONFIG);

    const required = [
      ...code.matchAll(/(?<=^|[\s=(,;])require\("([^"]+)"\)/gm),
    ].map(([, name]) => name);
    for (const name of required) {
      expect(builtinModules).toContain(name?.replace(/^node:/, ""));
    }
    expect(code).toContain('table: "shared-releases"');
    expect(code).not.toContain("deployRoleArn");
  });

  it("runs on its own, letting go of a message that names no release", async () => {
    const { responses, logs } = await invoke(
      buildDeadLetterWorker(DEAD_LETTER_CONFIG),
      ["SYNTHETIC text"],
    );

    expect(responses).toEqual([{ batchItemFailures: [] }]);
    expect(logs).toEqual([
      expect.objectContaining({
        telemetry: expect.objectContaining({
          event: "release_invalid",
        }) as unknown,
      }),
    ]);
  });

  it.each<[string, { region: string; table: string }]>([
    ["no region", { region: "", table: "shared-releases" }],
    [
      "a table given by its ARN",
      {
        region: "eu-west-2",
        table: "arn:aws:dynamodb:eu-west-2:000000000000:table/shared-releases",
      },
    ],
  ])("refuses to build with %s", (_, config) => {
    expect(() => buildDeadLetterWorker(config)).toThrow("dead-letter worker");
  });
});
