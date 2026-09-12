import { assert, describe, expect, it } from "vitest";

import { compilePaths, resolvePath, valueAt } from "./field-path.ts";

const compile = (paths: string[]) => compilePaths(paths);

describe("compilePaths", () => {
  it("splits dot-separated segments", () => {
    const [path] = compile(["a.b.c"]);
    assert(path);

    expect(path.segments).toEqual(["a", "b", "c"]);
    expect(path.raw).toBe("a.b.c");
  });

  it("marks wildcard paths", () => {
    const [plain, wild] = compile(["a.b", "a.*.b"]);
    assert(plain);
    assert(wild);

    expect(plain.wildcard).toBe(false);
    expect(wild.wildcard).toBe(true);
  });

  it("rejects empty path", () => {
    expect(() => compile([""])).toThrow("Invalid field path");
  });

  it("rejects path with empty segment", () => {
    expect(() => compile(["a..b"])).toThrow("Invalid field path");
  });
});

describe("resolvePath", () => {
  it("returns every match behind a wildcard", () => {
    expect(
      resolvePath({ users: [{ n: 1 }, { n: 2 }] }, ["users", "*", "n"]),
    ).toEqual([1, 2]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(resolvePath({ a: 1 }, ["missing"])).toEqual([]);
  });
});

describe("valueAt", () => {
  it("returns the value at an exact path", () => {
    expect(valueAt({ actor: { id: "abc" } }, ["actor", "id"])).toBe("abc");
  });

  it("returns undefined for an absent segment", () => {
    expect(valueAt({ actor: {} }, ["actor", "id"])).toBeUndefined();
  });

  it("returns undefined when the path dead-ends on a non-object", () => {
    expect(valueAt({ actor: "abc" }, ["actor", "id"])).toBeUndefined();
    expect(valueAt(null, ["a"])).toBeUndefined();
  });

  it("does not treat a wildcard as special", () => {
    expect(valueAt({ users: [{ n: 1 }] }, ["users", "*"])).toBeUndefined();
  });

  it("reads own properties only, never the prototype chain", () => {
    expect(valueAt({}, ["constructor"])).toBeUndefined();
    expect(valueAt({}, ["__proto__"])).toBeUndefined();
  });
});
