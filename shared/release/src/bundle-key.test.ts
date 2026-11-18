import { describe, expect, it } from "vitest";

import { bundleKey } from "./bundle-key.ts";

describe("bundleKey", () => {
  it("puts a bundle under its domain, named by its hash", () => {
    const sha256 =
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

    expect(bundleKey("example", sha256)).toBe(`example/bundle/${sha256}.zip`);
  });
});
