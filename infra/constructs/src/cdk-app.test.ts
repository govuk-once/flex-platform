import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { cdkApp, readFeatureFlags } from "./cdk-app.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function file(name: string, content?: string): URL {
  const directory = mkdtempSync(path.join(tmpdir(), "cdk-app-"));
  directories.push(directory);
  const filePath = path.join(directory, name);
  if (content !== undefined) writeFileSync(filePath, content);
  return pathToFileURL(filePath);
}

describe("cdkApp", () => {
  it("builds with the committed feature flags", () => {
    const app = cdkApp();

    expect(
      app.node.tryGetContext("@aws-cdk/aws-lambda:useCdkManagedLogGroup"),
    ).toBe(true);
  });

  it("takes extra context, which wins over a flag", () => {
    const app = cdkApp({
      stage: "platform-dev",
      "@aws-cdk/aws-lambda:useCdkManagedLogGroup": false,
    });

    expect(app.node.tryGetContext("stage")).toBe("platform-dev");
    expect(
      app.node.tryGetContext("@aws-cdk/aws-lambda:useCdkManagedLogGroup"),
    ).toBe(false);
  });
});

describe("readFeatureFlags", () => {
  it("refuses a missing file, naming where it looked", () => {
    const missing = file("cdk.json");

    expect(() => readFeatureFlags(missing)).toThrow(
      /cdk-app-.*cdk\.json, which doesn't exist/,
    );
  });

  it("refuses a file with no context", () => {
    expect(() =>
      readFeatureFlags(file("cdk.json", '{"app":"tsx bin/app.ts"}')),
    ).toThrow("has no context holding CDK's feature flags");
    expect(() =>
      readFeatureFlags(file("cdk.json", '{"context":["not", "flags"]}')),
    ).toThrow("has no context holding CDK's feature flags");
  });
});
