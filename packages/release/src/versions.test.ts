import { describe, expect, it } from "vitest";

import {
  bumped,
  candidateVersion,
  compareVersions,
  nextDerivedVersion,
  parseVersion,
  suggestedBump,
} from "./versions.ts";

describe("parseVersion", () => {
  it("reads a release version", () => {
    expect(parseVersion("1.12.3")).toEqual({ major: 1, minor: 12, patch: 3 });
  });

  it.each(["1.2", "1.2.3-rc.1", "01.2.3", "v1.2.3", "1.2.3+build"])(
    "refuses %s",
    (text) => {
      expect(() => parseVersion(text)).toThrow("is not a release version.");
    },
  );
});

describe("compareVersions", () => {
  it("orders by number, not by text", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("bumped", () => {
  it.each([
    ["patch", "0.1.4", "0.1.5"],
    ["minor", "0.1.4", "0.2.0"],
    ["major", "0.1.4", "1.0.0"],
  ] as const)("a %s of %s is %s", (bump, from, to) => {
    expect(bumped(from, bump)).toBe(to);
  });
});

describe("nextDerivedVersion", () => {
  it("is the built version for a first release", () => {
    expect(nextDerivedVersion("0.3.0", undefined)).toBe("0.3.0");
  });

  it("is the next patch under the same major and minor", () => {
    expect(nextDerivedVersion("0.3.0", "0.3.4")).toBe("0.3.5");
  });

  it("is the built version once the build is ahead", () => {
    expect(nextDerivedVersion("0.4.0", "0.3.4")).toBe("0.4.0");
    expect(nextDerivedVersion("1.4.0", "0.9.4")).toBe("1.4.0");
  });

  it("refuses a build behind its last release", () => {
    expect(() => nextDerivedVersion("0.2.0", "0.3.1")).toThrow(
      "The build wrote 0.2.0, behind 0.3.1, its last release.",
    );
  });

  it("refuses a build that sets its own patch", () => {
    expect(() => nextDerivedVersion("0.2.1", undefined)).toThrow("patch 0");
  });
});

describe("candidateVersion", () => {
  it("adds the candidate number", () => {
    expect(candidateVersion("0.2.0", 14)).toBe("0.2.0-rc.14");
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses %s", (n) => {
    expect(() => candidateVersion("0.2.0", n)).toThrow(
      "is not a candidate number.",
    );
  });
});

describe("suggestedBump", () => {
  it("suggests a minor for a feature, with or without a scope or a breaking change", () => {
    expect(
      suggestedBump(["FLEX-1 fix: Mend", "FLEX-2 feat(client): Add"]),
    ).toBe("minor");
    expect(suggestedBump(["FLEX-1 feat!: Rename"])).toBe("minor");
  });

  it("suggests a patch for anything else, and for titles in no known form", () => {
    expect(suggestedBump(["FLEX-1 fix!: Drop", "Merge pull request #2"])).toBe(
      "patch",
    );
    expect(suggestedBump([])).toBe("patch");
  });
});
