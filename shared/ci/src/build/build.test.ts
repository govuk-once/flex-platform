import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { CONFIG, functionUrlEvent, token } from "../../test/helpers.ts";
import type { CiConfig, FunctionUrlEvent } from "../function/types.ts";
import { buildCiFunction, HANDLER } from "./build.ts";

const execFile = promisify(execFileCb);

// Nothing listens here, so fetching the issuer's keys from it fails at once.
const UNREACHABLE_KEYS = "https://127.0.0.1:9/.well-known/jwks";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Invocation {
  readonly responses: unknown[];
  readonly logs: unknown[];
}

// Runs the bundle as Lambda would: `index.js` alone in a directory outside the workspace, so
// nothing it needs can be resolved from the repository, loaded as CommonJS by a fresh Node.
async function invoke(
  code: string,
  events: readonly FunctionUrlEvent[],
): Promise<Invocation> {
  const directory = mkdtempSync(path.join(tmpdir(), "pipeline-api-"));
  directories.push(directory);
  writeFileSync(path.join(directory, "index.js"), code);
  const script = `
    const logs = [];
    console.log = (line) => logs.push(JSON.parse(line));
    const { handler } = require("./index.js");
    (async () => {
      const responses = [];
      for (const event of JSON.parse(process.argv[1])) responses.push(await handler(event));
      process.stdout.write(JSON.stringify({ responses, logs }));
    })();
  `;
  const { stdout } = await execFile(
    process.execPath,
    ["-e", script, JSON.stringify(events)],
    { cwd: directory, env: { AWS_REGION: "eu-west-2" } },
  );
  return JSON.parse(stdout) as Invocation;
}

describe("buildCiFunction", () => {
  it("is deployed as index.js, with its handler exported by that name", () => {
    expect(HANDLER).toBe("index.handler");
  });

  it("needs nothing but Node's builtins", () => {
    const code = buildCiFunction(CONFIG);

    const required = [
      ...code.matchAll(/(?<=^|[\s=(,;])require\("([^"]+)"\)/gm),
    ].map(([, name]) => name);
    expect(required.length).toBeGreaterThan(0);
    for (const name of required) {
      expect(builtinModules).toContain(name?.replace(/^node:/, ""));
    }
  });

  it("runs on its own, answering a request without a token", async () => {
    const { responses, logs } = await invoke(buildCiFunction(CONFIG), [
      functionUrlEvent({ headers: { "x-flex-ci-token": undefined } }),
    ]);

    expect(responses).toEqual([
      expect.objectContaining({
        statusCode: 401,
        body: '{"message":"Unauthorized","type":"auth_error"}',
      }),
    ]);
    expect(logs).toEqual([
      expect.objectContaining({
        telemetry: expect.objectContaining({
          event: "ci_token_missing",
        }) as unknown,
      }),
    ]);
  });

  it("bakes in the config it was built with, and fails closed without the issuer's keys", async () => {
    const code = buildCiFunction({ ...CONFIG, keysUri: UNREACHABLE_KEYS });

    const { responses, logs } = await invoke(code, [
      // For another stage's pipeline API, so refused before any keys are needed.
      functionUrlEvent({
        headers: {
          "x-flex-ci-token": token({
            payload: { iss: "https://issuer.example" },
          }),
        },
      }),
      // From the issuer, so its keys are fetched, and can't be.
      functionUrlEvent(),
    ]);

    expect(responses).toEqual([
      expect.objectContaining({ statusCode: 401 }),
      expect.objectContaining({
        statusCode: 500,
        body: '{"message":"Internal server error","type":"server_error"}',
      }),
    ]);
    expect(logs).toEqual([
      expect.objectContaining({
        telemetry: {
          event: "ci_token_invalid",
          details: expect.objectContaining({ reason: "issuer" }) as unknown,
        },
      }),
      expect.objectContaining({
        level: "ERROR",
        telemetry: expect.objectContaining({ event: "ci_failed" }) as unknown,
      }),
    ]);
  });

  it.each<[string, Partial<CiConfig>, string]>([
    [
      "an issuer that isn't an https address",
      { issuer: "http://token.actions.githubusercontent.com" },
      "issuer",
    ],
    [
      "a keys address that isn't an https address",
      { keysUri: "token.actions.githubusercontent.com/.well-known/jwks" },
      "keys address",
    ],
    [
      "an audience that isn't an https address",
      { audience: "sandbox.flex-shared.example" },
      "audience",
    ],
    [
      "an environment whose name a path can't hold",
      { environments: [{ name: "Development", publishes: true, domains: [] }] },
      'The environment "Development"',
    ],
    [
      "an environment listed twice",
      {
        environments: [
          { name: "development", publishes: true, domains: [] },
          { name: "development", publishes: true, domains: ["example"] },
        ],
      },
      "The environment development is listed twice",
    ],
    [
      "a hosted domain whose name a path can't hold",
      {
        environments: [
          { name: "development", publishes: true, domains: ["a/b"] },
        ],
      },
      'The domain of development "a/b"',
    ],
    [
      "a domain registered twice",
      {
        domains: [
          { name: "example", repositoryId: "1", ownerId: "2" },
          { name: "example", repositoryId: "3", ownerId: "2" },
        ],
      },
      "The domain example is listed twice",
    ],
    [
      "a repository given by name",
      {
        domains: [
          {
            name: "example",
            repositoryId: "example-org/example-domain",
            ownerId: "2",
          },
        ],
      },
      "GitHub's IDs",
    ],
    [
      "a bucket whose name an address can't hold",
      { uploads: { bucket: "Shared_Code", region: "eu-west-2" } },
      "bucket",
    ],
    [
      "a bucket in no region",
      { uploads: { bucket: "shared-domain-code-000000000000", region: "" } },
      "bucket",
    ],
    [
      "an owner with no ID",
      { domains: [{ name: "example", repositoryId: "1", ownerId: "" }] },
      "GitHub's IDs",
    ],
    [
      "a release queue that isn't FIFO",
      {
        releases: {
          ...CONFIG.releases,
          queueUrl:
            "https://sqs.eu-west-2.amazonaws.com/000000000000/shared-release",
        },
      },
      "release queue",
    ],
    [
      "a release queue in another region than the bucket",
      {
        releases: {
          ...CONFIG.releases,
          queueUrl:
            "https://sqs.us-east-1.amazonaws.com/000000000000/shared-release.fifo",
        },
      },
      "release queue",
    ],
    [
      "a release table given by its ARN",
      {
        releases: {
          ...CONFIG.releases,
          table:
            "arn:aws:dynamodb:eu-west-2:000000000000:table/shared-releases",
        },
      },
      "release table",
    ],
    [
      "a release queue given by ARN",
      {
        releases: {
          ...CONFIG.releases,
          queueUrl: "arn:aws:sqs:eu-west-2:000000000000:shared-release.fifo",
        },
      },
      "release queue",
    ],
  ])("refuses to build with %s", (_, change, message) => {
    expect(() => buildCiFunction({ ...CONFIG, ...change })).toThrow(message);
  });
});
