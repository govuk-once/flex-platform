import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GatewayCheckError } from "./check-gateway.ts";
import { main } from "./cli.ts";
import {
  CLIENT_DIR,
  CONTRACT_MODULE,
  GENERATED_DIR,
  RUNTIME_DIR,
  VALIDATORS_DIR,
} from "./layout.ts";

// The command as a gateway package runs it, against a gateway written for the test.

const CONFIG = `
export default {
  id: "cli",
  driver: { type: "stub", createExecutor: () => Promise.reject(new Error("no executor")) },
  operations: { ping: {} },
};
`;

const SCHEMAS = `
export default {
  operations: {
    ping: {
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      outcomes: { ok: { type: "object" } },
    },
  },
};
`;

const execFile = promisify(execFileCb);

let gatewayDir: string;

async function writeGateway(schemas: string): Promise<void> {
  await writeFile(path.join(gatewayDir, "gateway.config.ts"), CONFIG);
  await writeFile(path.join(gatewayDir, "schemas.fixture.ts"), schemas);
}

beforeEach(async () => {
  // Under this package rather than the system temp directory: a gateway configuration imports
  // @repo/gateway-config, which resolves from here, and node_modules is ignored by git.
  gatewayDir = await mkdtemp(
    path.join(import.meta.dirname, "..", "node_modules", ".gateway-"),
  );
});

afterEach(async () => {
  await rm(gatewayDir, { recursive: true, force: true });
});

describe("main", () => {
  it("writes what the gateway runs and what a caller imports", async () => {
    await writeGateway(SCHEMAS);

    await main(gatewayDir);

    const gen = path.join(gatewayDir, GENERATED_DIR);
    expect((await readdir(gen)).toSorted()).toEqual(
      [CLIENT_DIR, RUNTIME_DIR].toSorted(),
    );
    expect(
      (await readdir(path.join(gen, RUNTIME_DIR, VALIDATORS_DIR))).toSorted(),
    ).toEqual(["index.js", "schemas.js"]);
    expect(await readdir(path.join(gen, CLIENT_DIR))).toEqual([
      CONTRACT_MODULE,
    ]);
  });

  it("refuses a configuration its schemas do not match, and writes nothing", async () => {
    await writeGateway(SCHEMAS.replace("ping:", "pong:"));

    await expect(main(gatewayDir)).rejects.toThrow(GatewayCheckError);
    await expect(
      readdir(path.join(gatewayDir, GENERATED_DIR)),
    ).rejects.toThrow();
  });

  it("refuses a schema that is not a schema before reading it against the configuration", async () => {
    // `required` is an array of strings. Written as anything else the schema is invalid, and
    // saying so is more use than the disagreement a checker would derive from it.
    await writeGateway(
      SCHEMAS.replace('required: ["id"]', 'required: "id"').replace(
        "ping:",
        "pong:",
      ),
    );

    await expect(main(gatewayDir)).rejects.toThrow(
      /Invalid schema for input of operation "pong"/,
    );
    await expect(
      readdir(path.join(gatewayDir, GENERATED_DIR)),
    ).rejects.toThrow();
  });

  it("reads the working directory when it is given none", async () => {
    // What the bin script passes, and what a gateway package's `codegen` script relies on.
    await writeGateway(SCHEMAS);
    const cwd = process.cwd();
    process.chdir(gatewayDir);
    try {
      await main();
    } finally {
      process.chdir(cwd);
    }

    expect(
      (await readdir(path.join(gatewayDir, GENERATED_DIR))).toSorted(),
    ).toEqual([CLIENT_DIR, RUNTIME_DIR].toSorted());
  });
});

// The command as a deployment runs it: the bin script, in a process of its own. It registers
// tsx, calls main, and turns a failure into a diagnostic and an exit code; none of that is
// reachable from this process.
describe("gateway-codegen", () => {
  const bin = path.join(import.meta.dirname, "..", "bin", "gateway-codegen.js");

  it("generates for the gateway it is run in", async () => {
    await writeGateway(SCHEMAS);

    const { stdout, stderr } = await execFile(process.execPath, [bin], {
      cwd: gatewayDir,
    });

    expect(stderr).toBe("");
    expect(stdout).toBe("");
    const gen = path.join(gatewayDir, GENERATED_DIR);
    expect((await readdir(gen)).toSorted()).toEqual(
      [CLIENT_DIR, RUNTIME_DIR].toSorted(),
    );
    expect(
      (await readdir(path.join(gen, RUNTIME_DIR, VALIDATORS_DIR))).toSorted(),
    ).toEqual(["index.js", "schemas.js"]);
  }, 60_000);

  it("reports why it stopped and exits non-zero", async () => {
    await writeGateway(SCHEMAS.replace("ping:", "pong:"));

    const failure: { code?: number; stderr?: string } = await execFile(
      process.execPath,
      [bin],
      { cwd: gatewayDir },
    ).catch((error: unknown) => error as { code: number; stderr: string });

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('operation "ping" has no schemas');
    // Nothing was written, and the message is the whole of the output.
    await expect(
      readdir(path.join(gatewayDir, GENERATED_DIR)),
    ).rejects.toThrow();
  }, 60_000);
});
