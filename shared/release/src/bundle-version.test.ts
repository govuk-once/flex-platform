import { describe, expect, it } from "vitest";

import { compareBundleVersions, isBundleVersion } from "./bundle-version.ts";

describe("isBundleVersion", () => {
  it.each(["0.0.0", "1.4.2", "10.20.30", "999999999.999999999.999999999"])(
    "takes %s",
    (value) => {
      expect(isBundleVersion(value)).toBe(true);
    },
  );

  it.each([
    ["nothing", ""],
    ["two parts", "1.4"],
    ["four parts", "1.4.2.0"],
    ["an empty part", "1..2"],
    ["a leading zero", "1.04.2"],
    ["a v", "v1.4.2"],
    ["a pre-release", "1.4.2-rc.1"],
    ["build metadata", "1.4.2+abc"],
    ["a part of ten digits", "1000000000.0.0"],
    ["a space", " 1.4.2"],
    ["a sign", "1.-4.2"],
    ["digits of another script", "1.٤.2"],
  ])("refuses %s", (_, value) => {
    expect(isBundleVersion(value)).toBe(false);
  });
});

describe("compareBundleVersions", () => {
  it.each([
    ["1.4.2", "2.0.0"],
    ["1.4.2", "1.5.0"],
    ["1.4.2", "1.4.3"],
    // By number, where text would put 1.10.0 first.
    ["1.9.0", "1.10.0"],
    ["0.0.9", "0.1.0"],
  ])("puts %s before %s", (earlier, later) => {
    expect(compareBundleVersions(earlier, later)).toBeLessThan(0);
    expect(compareBundleVersions(later, earlier)).toBeGreaterThan(0);
  });

  it("finds a version the same as itself", () => {
    expect(compareBundleVersions("1.4.2", "1.4.2")).toBe(0);
  });

  it("throws for a value that isn't a version", () => {
    expect(() => compareBundleVersions("1.4.2", "v1.4.2")).toThrow(
      "isn't a bundle's version",
    );
  });
});
