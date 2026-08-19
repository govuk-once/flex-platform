import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findUpSync } from "./find-up.ts";

describe("findUpSync", () => {
  // Temp tree:
  //   <root>/marker.root
  //   <root>/dup.marker
  //   <root>/mid/dup.marker
  //   <root>/mid/leaf/         (search starts here)
  let root = "";
  let start = "";

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "find-up-"));
    start = path.join(root, "mid", "leaf");
    mkdirSync(start, { recursive: true });
    writeFileSync(path.join(root, "marker.root"), "");
    writeFileSync(path.join(root, "dup.marker"), "");
    writeFileSync(path.join(root, "mid", "dup.marker"), "");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns a file that exists in the start directory", () => {
    const mid = path.join(root, "mid");
    expect(findUpSync("dup.marker", mid)).toBe(path.join(mid, "dup.marker"));
  });

  it("walks up to a parent directory to find the file", () => {
    expect(findUpSync("marker.root", start)).toBe(
      path.join(root, "marker.root"),
    );
  });

  it("returns the nearest match when the name exists at several levels", () => {
    expect(findUpSync("dup.marker", start)).toBe(
      path.join(root, "mid", "dup.marker"),
    );
  });

  it("throws when the file is not found up to the filesystem root", () => {
    expect(() => findUpSync("does-not-exist.marker", start)).toThrowError(
      /Could not find does-not-exist\.marker/,
    );
  });

  it("defaults to process.cwd() when no start directory is given", () => {
    // Vitest runs with cwd at the package root, which always has a package.json.
    expect(findUpSync("package.json")).toBe(
      path.join(process.cwd(), "package.json"),
    );
  });
});
