import { describe, expect, it } from "vitest";

import { UPLOADS } from "../../test/helpers.ts";
import { isCiPath } from "./ci-path.ts";

describe("isCiPath", () => {
  it.each([UPLOADS, "/ci/anything", "/ci/a/b/c"])("accepts %s", (uri) => {
    expect(isCiPath(uri)).toBe(true);
  });

  it.each([
    ["the root", "/"],
    ["the prefix alone", "/ci"],
    ["the prefix and a slash", "/ci/"],
    ["another prefix", "/api/environments"],
    ["a longer first segment", "/cid/environments"],
    ["the prefix in another case", "/CI/environments"],
    ["the prefix further down", "/app/ci/environments"],
    ["a doubled slash", "/ci//environments"],
    ["a trailing slash", `${UPLOADS}/`],
    ["a dot segment", "/ci/../api/environments"],
    ["an encoded slash", "/ci/environments%2fdevelopment"],
    ["an encoded dot", "/ci/%2e%2e/api"],
    ["a backslash", String.raw`/ci\environments`],
    ["no leading slash", "ci/environments"],
    ["nothing", ""],
  ])("refuses %s", (_, uri) => {
    expect(isCiPath(uri)).toBe(false);
  });
});
