import { describe, expect, it } from "vitest";

import { isPlainPath } from "./is-plain-path.ts";

describe("isPlainPath", () => {
  it.each([
    "/a",
    "/app/udp/v1/identity",
    "/ci/environments/development/domains/domain-a/uploads",
    "/v1/name.with.dots",
    "/v1/encoded%20space",
    "/v1/..hidden",
  ])("accepts %s", (uri) => {
    expect(isPlainPath(uri)).toBe(true);
  });

  it.each([
    ["nothing", ""],
    ["the root", "/"],
    ["a missing leading slash", "app/udp/v1"],
    ["an empty segment", "/app//v1"],
    ["a trailing slash", "/app/udp/v1/"],
    ["a dot segment", "/app/./v1"],
    ["a dot-dot segment", "/app/../v1"],
    ["a leading dot-dot segment", "/../app"],
    ["an encoded slash", "/app/v1%2Fidentity"],
    ["an encoded slash in capitals", "/app/v1%2fidentity"],
    ["an encoded backslash", "/app/v1%5cidentity"],
    ["an encoded dot", "/app/%2e%2e/v1"],
    ["a backslash", "/app/v1\\identity"],
  ])("refuses %s", (_, uri) => {
    expect(isPlainPath(uri)).toBe(false);
  });
});
