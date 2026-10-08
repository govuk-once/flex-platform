import { describe, expect, it } from "vitest";

import { isRoutable } from "./path.ts";

describe("isRoutable", () => {
  it.each([
    "/app/udp",
    "/app/udp/v1/identity",
    "/app/travel/v1/journeys/abc-123",
    "/app/a/v1",
    `/app/a${"b".repeat(31)}/v1`,
    "/app/udp/v1/name.with.dots",
    "/app/udp/v1/encoded%20space",
  ])("routes %s", (uri) => {
    expect(isRoutable(uri)).toBe(true);
  });

  it.each([
    ["the root", "/"],
    ["/app alone", "/app"],
    ["a path outside /app", "/docs/index.html"],
    ["a missing leading slash", "app/udp/v1"],
    ["an empty domain", "/app//v1"],
    ["a domain with a dot", "/app/udp.evil.example/v1"],
    ["a domain with a port", "/app/udp:8443/v1"],
    ["a domain in capitals", "/app/UDP/v1"],
    ["a domain starting with a digit", "/app/1udp/v1"],
    ["a domain ending with a hyphen", "/app/udp-/v1"],
    ["a domain of 33 characters", `/app/a${"b".repeat(32)}/v1`],
    ["an empty segment", "/app/udp//v1"],
    ["a trailing slash", "/app/udp/v1/"],
    ["a dot segment", "/app/udp/./v1"],
    ["a dot-dot segment", "/app/udp/../travel/v1"],
    ["an encoded slash", "/app/udp/v1%2Fidentity"],
    ["an encoded backslash", "/app/udp/v1%5cidentity"],
    ["an encoded dot", "/app/udp/%2e%2e/travel"],
    ["a backslash", "/app/udp/v1\\identity"],
  ])("refuses %s", (_, uri) => {
    expect(isRoutable(uri)).toBe(false);
  });
});
