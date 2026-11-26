import { isRecord } from "@repo/utils/is-record";
import { assert, describe, expect, it } from "vitest";

import { parseJson, pathParameters, queryParameters } from "./request-input.ts";

describe("queryParameters", () => {
  it("gives a parameter sent once as text, and one sent more than once as a list, in order", () => {
    const search = new URLSearchParams("page=2&tag=a&tag=b&tag=c&empty=");

    expect(queryParameters(search)).toEqual(
      new Map<string, string | readonly string[]>([
        ["page", "2"],
        ["tag", ["a", "b", "c"]],
        ["empty", ""],
      ]),
    );
  });
});

describe("pathParameters", () => {
  it("decodes each parameter once", () => {
    expect(pathParameters(new Map([["name", "a%20b%2525"]]))).toEqual(
      new Map([["name", "a b%25"]]),
    );
  });

  it.each([
    ["does not decode", "%E0%A4%A"],
    ["decodes to a slash", "a%2Fb"],
  ])("refuses a parameter that %s", (_case, raw) => {
    expect(
      pathParameters(
        new Map([
          ["id", "1"],
          ["name", raw],
        ]),
      ),
    ).toBeUndefined();
  });
});

describe("parseJson", () => {
  // Nested `depth` arrays deep, around `inner`.
  function nested(depth: number, inner = "1"): string {
    return `${"[".repeat(depth)}${inner}${"]".repeat(depth)}`;
  }

  it("parses every object without a prototype, inside objects and arrays alike", () => {
    const parsed = parseJson('{"a":{"b":1},"list":[{"c":2}]}');

    assert(parsed.ok);
    assert(isRecord(parsed.value));

    const { a, list } = parsed.value;

    assert(Array.isArray(list));

    expect(parsed.value).toEqual({ a: { b: 1 }, list: [{ c: 2 }] });
    expect(Object.getPrototypeOf(parsed.value)).toBeNull();
    expect(Object.getPrototypeOf(a)).toBeNull();
    expect(Object.getPrototypeOf(list[0])).toBeNull();
    expect(Object.getPrototypeOf(list)).toBe(Array.prototype);
  });

  it("finds no field the request did not set", () => {
    const parsed = parseJson("{}");

    assert(parsed.ok);
    assert(isRecord(parsed.value));

    expect("toString" in parsed.value).toBe(false);
    expect("constructor" in parsed.value).toBe(false);
  });

  it.each([
    ["at the top", '{"__proto__":{"admin":true}}'],
    ["in a nested object", '{"a":{"__proto__":{"admin":true}}}'],
    ["in an object in an array", '[{"__proto__":null}]'],
  ])("refuses a `__proto__` key %s", (_case, text) => {
    expect(parseJson(text)).toEqual({
      ok: false,
      reason: "holds a __proto__ key",
    });
  });

  it("parses a value nested as deep as the limit", () => {
    expect(parseJson(nested(64))).toMatchObject({ ok: true });
  });

  it.each([
    ["arrays", nested(65)],
    ["objects", `${'{"a":'.repeat(65)}1${"}".repeat(65)}`],
    ["text too deep to parse", nested(100_000)],
  ])("refuses %s nested deeper than the limit", (_case, text) => {
    expect(parseJson(text)).toEqual({ ok: false, reason: "nested too deeply" });
  });

  it.each([
    ["brackets", nested(64, '"[[[{{{"')],
    ["an escaped quote before brackets", nested(64, '"\\"[[[{{{"')],
  ])("does not count %s inside a string", (_case, text) => {
    expect(parseJson(text)).toMatchObject({ ok: true });
  });

  it("refuses text that is not JSON", () => {
    expect(parseJson("{")).toEqual({ ok: false, reason: "malformed JSON" });
  });
});
