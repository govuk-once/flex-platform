import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  CLIENT_ID,
  ISSUERS,
  originRequestEvent,
  token,
  TRACE_ID,
} from "../../test/helpers.ts";
import type {
  OriginRequestConfig,
  OriginRequestEvent,
} from "../function/types.ts";
import { buildOriginRequestFunction } from "./build.ts";

const execFile = promisify(execFileCb);

// Nothing listens here, so fetching an issuer's keys from it fails at once.
const UNREACHABLE_ISSUER = "https://127.0.0.1:9/eu-west-2_unreachable";

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
  events: readonly OriginRequestEvent[],
): Promise<Invocation> {
  const directory = mkdtempSync(path.join(tmpdir(), "lambda-edge-"));
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
    {
      cwd: directory,
      env: { AWS_REGION: "eu-west-2", AWS_LAMBDA_FUNCTION_VERSION: "3" },
    },
  );
  return JSON.parse(stdout) as Invocation;
}

function withToken(value: string): OriginRequestEvent {
  return originRequestEvent({
    headers: { authorization: `Bearer ${value}`, "x-correlation-id": TRACE_ID },
  });
}

describe("buildOriginRequestFunction", () => {
  it("needs nothing but Node's builtins", () => {
    const code = buildOriginRequestFunction({ issuers: ISSUERS, routes: {} });

    const required = [...code.matchAll(/\brequire\("([^"]+)"\)/g)].map(
      ([, name]) => name,
    );
    expect(required.length).toBeGreaterThan(0);
    for (const name of required) {
      expect(builtinModules).toContain(name?.replace(/^node:/, ""));
    }
  });

  it("runs on its own, answering a request without a token", async () => {
    const code = buildOriginRequestFunction({ issuers: ISSUERS, routes: {} });

    const { responses, logs } = await invoke(code, [
      originRequestEvent({ headers: {} }),
    ]);

    expect(responses).toEqual([
      expect.objectContaining({
        status: "401",
        body: '{"message":"Unauthorized","type":"auth_error"}',
      }),
    ]);
    expect(logs).toEqual([
      expect.objectContaining({
        telemetry: expect.objectContaining({
          event: "lae_token_missing",
        }) as unknown,
      }),
    ]);
  });

  it("bakes in the issuers it was built with, and fails closed without their keys", async () => {
    const config: OriginRequestConfig = {
      issuers: [{ issuer: UNREACHABLE_ISSUER, clientIds: [CLIENT_ID] }],
      routes: {},
    };
    const code = buildOriginRequestFunction(config);

    const { responses, logs } = await invoke(code, [
      // Trusted by another environment's config, not this one.
      withToken(token()),
      // Trusted here, so its keys are fetched, and can't be.
      withToken(token({ payload: { iss: UNREACHABLE_ISSUER } })),
    ]);

    expect(responses).toEqual([
      expect.objectContaining({ status: "401" }),
      expect.objectContaining({
        status: "500",
        body: '{"message":"Internal server error","type":"server_error"}',
      }),
    ]);
    expect(logs).toEqual([
      expect.objectContaining({
        telemetry: {
          event: "lae_token_invalid",
          details: expect.objectContaining({ reason: "issuer" }) as unknown,
        },
      }),
      expect.objectContaining({
        level: "ERROR",
        telemetry: expect.objectContaining({ event: "lae_failed" }) as unknown,
      }),
    ]);
  });

  it("bakes in the routes it was built with", () => {
    const code = buildOriginRequestFunction({
      issuers: ISSUERS,
      routes: { udp: "udp.development.flex-domain00.once.service.gov.uk" },
    });

    expect(code).toContain(
      '"udp.development.flex-domain00.once.service.gov.uk"',
    );
  });

  it.each([
    [
      "a domain the CloudFront Function would refuse",
      { "Bad.Name": "a.example" },
    ],
    ["a host that isn't a DNS name", { udp: "https://a.example" }],
    ["a host with one label", { udp: "localhost" }],
  ])("refuses %s", (_, routes) => {
    expect(() =>
      buildOriginRequestFunction({ issuers: ISSUERS, routes }),
    ).toThrow(/route/);
  });
});
