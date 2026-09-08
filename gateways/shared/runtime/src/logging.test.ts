import { assert, describe, expect, it } from "vitest";

import { compilePaths, pickFields } from "./logging.ts";

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

describe("pickFields", () => {
  it("returns undefined for empty paths", () => {
    expect(pickFields({ a: 1 }, [])).toBeUndefined();
  });

  it("picks only named fields", () => {
    const data = { email: "a@b.com", secret: "TOKEN", name: "Alice" };
    expect(pickFields(data, compile(["email"]))).toEqual({
      email: "a@b.com",
    });
  });

  it("picks multiple fields", () => {
    const data = { email: "a@b.com", name: "Alice", secret: "TOKEN" };
    expect(pickFields(data, compile(["email", "name"]))).toEqual({
      email: "a@b.com",
      name: "Alice",
    });
  });

  it("resolves nested paths", () => {
    const data = { address: { city: "London", postcode: "SW1" } };
    expect(pickFields(data, compile(["address.city"]))).toEqual({
      "address.city": "London",
    });
  });

  it("resolves wildcard over object keys", () => {
    const data = { items: { a: { id: 1 }, b: { id: 2 } } };
    expect(pickFields(data, compile(["items.*.id"]))).toEqual({
      "items.*.id": [1, 2],
    });
  });

  it("resolves wildcard over array indexes", () => {
    const data = { users: [{ name: "Alice" }, { name: "Bob" }] };
    expect(pickFields(data, compile(["users.*.name"]))).toEqual({
      "users.*.name": ["Alice", "Bob"],
    });
  });

  it("resolves wildcard over nested arrays", () => {
    const data = {
      matrix: [[{ v: 1 }, { v: 2 }], [{ v: 3 }]],
    };
    expect(pickFields(data, compile(["matrix.*.*.v"]))).toEqual({
      "matrix.*.*.v": [1, 2, 3],
    });
  });

  it("returns single value for non-wildcard path", () => {
    const data = { items: [{ id: 1 }] };
    expect(pickFields(data, compile(["items"]))).toEqual({
      items: [{ id: 1 }],
    });
  });

  it("returns undefined when no paths match", () => {
    expect(pickFields({ x: 1 }, compile(["missing"]))).toBeUndefined();
  });

  it("omits unmatched paths but includes matched ones", () => {
    const data = { a: 1, b: 2 };
    expect(pickFields(data, compile(["a", "missing"]))).toEqual({ a: 1 });
  });

  it("handles non-object data gracefully", () => {
    expect(pickFields("string", compile(["field"]))).toBeUndefined();
    expect(pickFields(null, compile(["field"]))).toBeUndefined();
    expect(pickFields(42, compile(["field"]))).toBeUndefined();
  });

  it("skips undefined values in wildcard expansion", () => {
    const data = { items: [{ id: 1 }, { noId: true }] };
    expect(pickFields(data, compile(["items.*.id"]))).toEqual({
      "items.*.id": [1],
    });
  });

  it("handles mixed arrays and objects in wildcard", () => {
    const data = {
      records: { a: { score: 10 }, b: { score: 20 } },
      list: [{ score: 30 }],
    };
    const paths = compile(["records.*.score", "list.*.score"]);
    expect(pickFields(data, paths)).toEqual({
      "records.*.score": [10, 20],
      "list.*.score": [30],
    });
  });
});
