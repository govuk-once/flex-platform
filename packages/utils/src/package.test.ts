import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Any package may use these functions, so the package depends on nothing in the workspace: a
// package it depended on could never use them. Its own tooling is not installed with it.
const INSTALLED = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

type Manifest = Partial<
  Record<(typeof INSTALLED)[number], Record<string, string>>
>;

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as Manifest;

describe("the package", () => {
  it("depends on no workspace package", () => {
    const workspace = INSTALLED.flatMap((field) =>
      Object.entries(manifest[field] ?? {})
        .filter(
          ([name, version]) =>
            version.startsWith("workspace:") ||
            name.startsWith("@repo/") ||
            name.startsWith("@govuk-once/"),
        )
        .map(([name]) => `${field}: ${name}`),
    );
    expect(workspace).toEqual([]);
  });
});
