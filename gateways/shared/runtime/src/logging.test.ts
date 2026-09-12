import { describe, expect, it } from "vitest";

import { compilePaths } from "./field-path.ts";
import { pickFields } from "./logging.ts";

const compile = (paths: string[]) => compilePaths(paths);

describe("pickFields", () => {
  it("returns an empty object for empty paths", () => {
    expect(pickFields({ a: 1 }, [])).toEqual({});
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
    const data = { count: 1 };
    expect(pickFields(data, compile(["count"]))).toEqual({ count: 1 });
  });

  it("drops a path that resolves to an object", () => {
    // Logging the subtree would mean any field the upstream later adds under `address`
    // becomes a new log leak without the allowlist changing.
    const data = { address: { city: "London", nino: "QQ123456C" } };
    expect(pickFields(data, compile(["address"]))).toEqual({});
  });

  it("drops a path that resolves to an array", () => {
    const data = { items: [{ id: 1 }] };
    expect(pickFields(data, compile(["items"]))).toEqual({});
  });

  it("keeps the scalar leaves under a dropped parent", () => {
    const data = { address: { city: "London", nino: "QQ123456C" } };
    expect(pickFields(data, compile(["address", "address.city"]))).toEqual({
      "address.city": "London",
    });
  });

  it("filters non-scalars out of a wildcard match", () => {
    const data = { mixed: [1, { nested: "SECRET" }, 3] };
    expect(pickFields(data, compile(["mixed.*"]))).toEqual({
      "mixed.*": [1, 3],
    });
  });

  it("drops a wildcard match that is entirely non-scalar", () => {
    const data = { rows: [{ a: 1 }, { b: 2 }] };
    expect(pickFields(data, compile(["rows.*"]))).toEqual({});
  });

  it("returns an empty object when no paths match", () => {
    expect(pickFields({ x: 1 }, compile(["missing"]))).toEqual({});
  });

  it("omits unmatched paths but includes matched ones", () => {
    const data = { a: 1, b: 2 };
    expect(pickFields(data, compile(["a", "missing"]))).toEqual({ a: 1 });
  });

  it("handles non-object data gracefully", () => {
    expect(pickFields("string", compile(["field"]))).toEqual({});
    expect(pickFields(null, compile(["field"]))).toEqual({});
    expect(pickFields(42, compile(["field"]))).toEqual({});
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
