import { GatewayError } from "@repo/gateway-runtime";
import { describe, expect, it } from "vitest";

import { encodePathParam } from "./path.ts";

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
  it("leaves unreserved characters alone", () => {
    expect(encodePathParam("abc-123_x.y~z", "ctx")).toBe("abc-123_x.y~z");
  });

  // An accepted value reaches the upstream as the caller wrote it, in one segment.
  it.each([
    "file.tar.gz",
    "..hidden",
    "trailing..",
    "..a..",
    "1 2",
    "a@b.test",
    "x=y&z",
    "a:b;c",
    "!$'()*+,",
    "\u017c\u00f3\u0142\u0107",
    "a\u{1f600}b",
  ])("accepts %j and decodes back unchanged", (value) => {
    const encoded = encodePathParam(value, "ctx");
    expect(encoded).not.toContain("/");
    expect(decodeURIComponent(encoded)).toBe(value);
  });

  // Round-tripping alone would also accept an unencoded value, so the output is pinned.
  it.each([
    ["abc-123_x.y~z", "abc-123_x.y~z"],
    ["file.tar.gz", "file.tar.gz"],
    ["..hidden", "..hidden"],
    ["1 2", "1%202"],
    ["a@b.test", "a%40b.test"],
    ["x=y&z", "x%3Dy%26z"],
    ["a:b;c", "a%3Ab%3Bc"],
    ["!$'()*+,", "!%24'()*%2B%2C"],
    ["\u017c\u00f3\u0142\u0107", "%C5%BC%C3%B3%C5%82%C4%87"],
    ["a\u{1f600}b", "a%F0%9F%98%80b"],
  ])("encodes %j as %j", (value, expected) => {
    expect(encodePathParam(value, "ctx")).toBe(expected);
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
