import { GatewayError } from "@repo/gateway-runtime";
import { describe, expect, it } from "vitest";

import { encodePathParam, hasDotSegment } from "./path.ts";

// Requires a throw. Returning a stand-in error here would let a value that is wrongly accepted
// pass every assertion below.
function rejection(value: string): GatewayError {
  try {
    encodePathParam(value, "ctx");
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(GatewayError);
    return err as GatewayError;
  }
  throw new Error(`encodePathParam accepted ${JSON.stringify(value)}`);
}

describe("encodePathParam", () => {
  // An accepted value reaches the upstream as the caller wrote it, in one segment. Round-tripping
  // alone would also accept an unencoded value, so the output is pinned beside it.
  it.each([
    ["abc-123_x.y~z", "abc-123_x.y~z"],
    ["file.tar.gz", "file.tar.gz"],
    ["..hidden", "..hidden"],
    ["trailing..", "trailing.."],
    ["..a..", "..a.."],
    ["1 2", "1%202"],
    ["a@b.test", "a%40b.test"],
    ["x=y&z", "x%3Dy%26z"],
    ["a:b;c", "a%3Ab%3Bc"],
    ["!$'()*+,", "!%24'()*%2B%2C"],
    ["\u017c\u00f3\u0142\u0107", "%C5%BC%C3%B3%C5%82%C4%87"],
    ["a\u{1f600}b", "a%F0%9F%98%80b"],
  ])("encodes %j as %j, in one segment", (value, expected) => {
    const encoded = encodePathParam(value, "ctx");
    expect(encoded).toBe(expected);
    expect(encoded).not.toContain("/");
    expect(decodeURIComponent(encoded)).toBe(value);
  });

  it.each([
    ["", /must not be empty/],
    [".", /dot segment/],
    ["..", /dot segment/],
    ["...", /dot segment/],
    ["a/b", /single path segment/],
    ["a\\b", /single path segment/],
    ["a?b", /single path segment/],
    ["a#b", /single path segment/],
    ["%", /single path segment/],
    // Percent is refused so a doubly decoding upstream cannot recover a separator either.
    ["%252e%252e%252f", /single path segment/],
    ["a\tb", /single path segment/],
    ["a\rb", /single path segment/],
    ["a\nb", /single path segment/],
    ["a\u001fb", /single path segment/],
    ["a\u007fb", /single path segment/],
    // encodeURIComponent would raise a URIError of its own for each of these.
    ["a\ud800b", /well-formed Unicode/],
    ["a\udbffb", /well-formed Unicode/],
    ["a\udc00b", /well-formed Unicode/],
    ["a\udfffb", /well-formed Unicode/],
    ["\ud800", /well-formed Unicode/],
  ])("rejects %j", (value, message) => {
    const err = rejection(value);
    expect(err.code).toBe("INTERNAL");
    expect(err.message).toMatch(/^ctx: /);
    expect(err.message).toMatch(message);
    // Nothing of a library error is attached: a cause would carry the value into the logs.
    expect(err.cause).toBeUndefined();
  });

  it.each([
    "SYNTHETIC_SECRET/x",
    "SYNTHETIC_SECRET%2e",
    "SYNTHETIC_SECRET\u0000",
    "SYNTHETIC_SECRET\ud800",
  ])("never includes %j in its diagnostics", (value) => {
    const err = rejection(value);
    expect(err.code).toBe("INTERNAL");
    expect(err.message).toMatch(/^ctx: /);
    expect(err.message).not.toContain("SYNTHETIC_SECRET");
    expect(err.cause).toBeUndefined();
  });
});

describe("hasDotSegment", () => {
  it.each([
    "/a/../b",
    "/a/./b",
    "/..",
    "/.",
    "/a/..",
    // The spellings the URL parser folds back to a dot before it resolves the segment.
    "/a/%2e%2e/b",
    "/a/%2E%2E/b",
    "/a/.%2e/b",
    "/a/%2e./b",
    "/a/%2E/b",
    // The URL parser separates on a backslash too, so these are dot segments to it.
    "/a\\..\\b",
    "/a\\%2e%2e\\b",
    "/a/..\\b",
    // The parser removes these before it reads the path, so each of these is ".." to it. The
    // last splits a percent escape, which it also rejoins before decoding.
    "/users/.\t./admin",
    "/users/.\n./admin",
    "/users/.\r./admin",
    "/users/%2\te%2e/admin",
  ])("finds a dot segment in %j", (path) => {
    expect(hasDotSegment(path)).toBe(true);
  });

  it.each([
    "/a/b",
    "/",
    "/a.b/c",
    "/...",
    "/a%2e/b",
    "/%2eb/c",
    // A dot that cannot become a segment: "%2f" is not a separator to the parser.
    "/a/x%2f..%2fy/b",
    "/files/a%2Fb%3Fc",
    "/a%5c..%5cb",
  ])("leaves %j alone", (path) => {
    expect(hasDotSegment(path)).toBe(false);
  });
});
