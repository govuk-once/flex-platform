import { GatewayError } from "@repo/gateway-runtime";
import { describe, expect, it } from "vitest";

import { defineHandler } from "../config/handler.ts";
import { compileOperation } from "./operation.ts";

describe("compileOperation", () => {
  it("exposes the parsed upstream and handler", () => {
    const handler = defineHandler(() =>
      Promise.resolve({ outcome: "ok", data: null }),
    );
    const op = compileOperation("getUser", {
      upstream: "GET /users/{id}",
      parameters: { id: { in: "path" } },
      handler,
    });
    expect(op.name).toBe("getUser");
    expect(op.upstream.method).toBe("GET");
    expect(op.handler).toBe(handler);
  });

  it.each([
    [
      {
        upstream: "GET /users/{id}",
        parameters: { x: { in: "path", name: "other" } },
      },
      /names path parameter "\{other\}", which is not in the template/,
    ],
    [
      {
        upstream: "GET /users/{id}",
        parameters: { payload: { in: "path", name: "id" } },
      },
      /"payload" is the request body and cannot be a parameter/,
    ],
    [
      { upstream: "GET /users", parameters: { payload: { in: "query" } } },
      /"payload" is the request body/,
    ],
    [
      { upstream: "GET /users", parameters: { "": { in: "query" } } },
      /parameter fields must be non-empty/,
    ],
    [
      { upstream: "GET /users", parameters: { q: { in: "query", name: "" } } },
      /parameter "q" has an empty upstream name/,
    ],
    [
      {
        upstream: "GET /users",
        parameters: { ct: { in: "header", name: "content-type" } },
      },
      /set by the driver/,
    ],
    [
      {
        upstream: "GET /users",
        parameters: { h: { in: "header", name: "bad name" } },
      },
      /not a valid header name/,
    ],
    [
      {
        upstream: "GET /users/{id}",
        parameters: {
          a: { in: "path", name: "id" },
          b: { in: "path", name: "id" },
        },
      },
      /path parameter "\{id\}" is supplied by more than one field/,
    ],
    [
      {
        upstream: "GET /users",
        parameters: {
          a: { in: "query", name: "q" },
          b: { in: "query", name: "q" },
        },
      },
      /query parameter "q" is supplied by more than one field/,
    ],
    [
      {
        upstream: "GET /users",
        parameters: {
          a: { in: "header", name: "X-Id" },
          b: { in: "header", name: "x-id" },
        },
      },
      /header "x-id" is supplied by more than one field/,
    ],
    [
      { upstream: "GET /users/{id}" },
      /path parameter "\{id\}" needs a parameters entry with in: "path"/,
    ],
    [
      { upstream: "GET /users/{id}", parameters: { id: { in: "query" } } },
      /path parameter "\{id\}" needs a parameters entry with in: "path"/,
    ],
    [
      {
        upstream: "GET /orgs/{orgId}/users/{id}",
        parameters: { id: { in: "path" } },
      },
      /path parameter "\{orgId\}" needs a parameters entry/,
    ],
    [
      {
        upstream: "GET /users",
        parameters: { q: { in: "cookie" as "query" } },
      },
      /unknown location "cookie"/,
    ],
  ] as const)("rejects %j at compile time", (config, message) => {
    expect(() => compileOperation("op", config)).toThrow(message);
  });

  it("lets a same-named field feed the path when another field is renamed onto it", () => {
    // {id} reads input.userId explicitly; input.id is then free to go to the query string.
    const op = compileOperation("op", {
      upstream: "GET /users/{id}",
      parameters: { userId: { in: "path", name: "id" }, id: { in: "query" } },
    });
    expect(op.prepare({ userId: "u1", id: "other" })).toEqual({
      method: "GET",
      path: "/users/u1",
      query: { id: "other" },
    });
  });
});

describe("compileOperation upstream parsing", () => {
  it("propagates upstream parse errors", () => {
    expect(() =>
      compileOperation("op", { upstream: "FETCH /users" as "GET /users" }),
    ).toThrow(/unsupported method/);
  });
});

describe("prepare", () => {
  it("fills declared path parameters from same-named input fields", () => {
    const op = compileOperation("getUser", {
      upstream: "GET /orgs/{orgId}/users/{id}",
      parameters: { orgId: { in: "path" }, id: { in: "path" } },
    });
    expect(op.prepare({ orgId: "acme", id: 42 })).toEqual({
      method: "GET",
      path: "/orgs/acme/users/42",
    });
  });

  it("fills renamed path parameters", () => {
    const op = compileOperation("getUser", {
      upstream: "GET /users/{id}",
      parameters: { userId: { in: "path", name: "id" } },
    });
    expect(op.prepare({ userId: "u1" }).path).toBe("/users/u1");
  });

  it("percent-encodes path parameter values", () => {
    const op = compileOperation("getFile", {
      upstream: "GET /files/{name}",
      parameters: { name: { in: "path" } },
    });
    expect(op.prepare({ name: "d e&f=g@h+i" }).path).toBe(
      "/files/d%20e%26f%3Dg%40h%2Bi",
    );
  });

  it("encodes unicode path values", () => {
    const op = compileOperation("get", {
      upstream: "GET /x/{v}",
      parameters: { v: { in: "path" } },
    });
    expect(op.prepare({ v: "żółć" }).path).toBe("/x/%C5%BC%C3%B3%C5%82%C4%87");
  });

  it.each([".", "..", "...", "....."])(
    "rejects the dot-only value %j",
    (value) => {
      const op = compileOperation("get", {
        upstream: "GET /x/{v}/y",
        parameters: { v: { in: "path" } },
      });
      expect(() => op.prepare({ v: value })).toThrow(/dot segment/);
    },
  );

  it("rejects an empty path value", () => {
    const op = compileOperation("get", {
      upstream: "GET /x/{v}",
      parameters: { v: { in: "path" } },
    });
    expect(() => op.prepare({ v: "" })).toThrow(/must not be empty/);
  });

  it.each([
    "../../admin",
    "..\\..\\admin",
    "a/b",
    "%2e%2e%2f",
    "%2e%2e/",
    "x?admin=1",
    "x#frag",
    "x\u0000y",
    "x\ny",
    "x\u007fy",
    "%",
    "%252e%252e%252f",
  ])("rejects the multi-segment or control value %j", (value) => {
    const op = compileOperation("get", {
      upstream: "GET /users/{id}",
      parameters: { id: { in: "path" } },
    });
    expect(() => op.prepare({ id: value })).toThrow(
      /cannot appear in a single path segment/,
    );
  });

  // Mimics an upstream that percent-decodes the path before normalising dot segments, as some
  // proxies do. Every accepted value must still route under the operation's own prefix.
  function routeLikeDecodingUpstream(path: string): string {
    const target = new URL("https://h.test/tenant");
    return new URL(decodeURIComponent(target.pathname + path), target.origin)
      .pathname;
  }

  it.each([
    "u1",
    "a@b.test",
    "..hidden",
    "trailing..",
    "..a..",
    "1 2",
    "żółć",
    "x=y&z",
    "a:b;c",
    "!$'()*+,",
    "a\u{1f600}b",
  ])("keeps %j under the route after upstream decoding", (value) => {
    const op = compileOperation("get", {
      upstream: "GET /users/{id}",
      parameters: { id: { in: "path" } },
    });
    // Every value here must be accepted: a rejection is a failure, not a pass.
    const { path } = op.prepare({ id: value });
    const routed = routeLikeDecodingUpstream(path);
    expect(routed.startsWith("/tenant/users/")).toBe(true);
    expect(routed.slice("/tenant/users/".length)).not.toContain("/");
  });

  it("rejects a path value that is not well-formed Unicode", () => {
    const op = compileOperation("get", {
      upstream: "GET /users/{id}",
      parameters: { id: { in: "path" } },
    });
    expect(() => op.prepare({ id: "x\ud800y" })).toThrow(/well-formed Unicode/);
  });

  it("rejects a missing path parameter", () => {
    const op = compileOperation("get", {
      upstream: "GET /x/{v}",
      parameters: { v: { in: "path" } },
    });
    expect(() => op.prepare({})).toThrow(
      /path parameter "v" needs a scalar input field "v"/,
    );
  });

  it("rejects a non-scalar path parameter", () => {
    const op = compileOperation("get", {
      upstream: "GET /x/{v}",
      parameters: { v: { in: "path" } },
    });
    expect(() => op.prepare({ v: { nested: true } })).toThrow(/needs a scalar/);
  });

  it("maps query fields with and without a renamed upstream name", () => {
    const op = compileOperation("search", {
      upstream: "GET /users",
      parameters: {
        state: { in: "query", name: "status" },
        limit: { in: "query" },
        ids: { in: "query" },
      },
    });
    expect(
      op.prepare({ state: "active", limit: 10, ids: ["a", "b"] }).query,
    ).toEqual({ status: "active", limit: 10, ids: ["a", "b"] });
  });

  it("omits null and undefined query values and drops an empty query", () => {
    const op = compileOperation("search", {
      upstream: "GET /users",
      parameters: { a: { in: "query" }, b: { in: "query" } },
    });
    expect(op.prepare({ a: null, b: undefined })).toEqual({
      method: "GET",
      path: "/users",
    });
  });

  it("rejects a non-scalar query value", () => {
    const op = compileOperation("search", {
      upstream: "GET /users",
      parameters: { filter: { in: "query" } },
    });
    expect(() => op.prepare({ filter: { a: 1 } })).toThrow(
      /query parameter "filter" needs a scalar/,
    );
  });

  it("maps header fields with lowercase names", () => {
    const op = compileOperation("get", {
      upstream: "GET /users",
      parameters: {
        requestId: { in: "header", name: "X-Request-Id" },
        skip: { in: "header", name: "X-Skip" },
        "x-trace": { in: "header" },
      },
    });
    expect(
      op.prepare({ requestId: "r1", skip: null, "x-trace": "t" }).headers,
    ).toEqual({ "x-request-id": "r1", "x-trace": "t" });
  });

  it("sends payload as the body on methods that take one", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const op = compileOperation("write", { upstream: `${method} /users` });
      expect(op.prepare({ payload: { email: "a@b.test" } })).toEqual({
        method,
        path: "/users",
        body: { email: "a@b.test" },
      });
    }
  });

  it("rejects a payload on GET", () => {
    const op = compileOperation("get", { upstream: "GET /users" });
    expect(() => op.prepare({ payload: {} })).toThrow(
      /GET requests cannot carry a "payload"/,
    );
  });

  it("combines path, query, headers and payload", () => {
    const op = compileOperation("update", {
      upstream: "PATCH /users/{id}",
      parameters: {
        id: { in: "path" },
        dryRun: { in: "query" },
        etag: { in: "header", name: "if-match" },
      },
    });
    expect(
      op.prepare({ id: "u1", dryRun: true, etag: "abc", payload: { n: 1 } }),
    ).toEqual({
      method: "PATCH",
      path: "/users/u1",
      query: { dryRun: true },
      headers: { "if-match": "abc" },
      body: { n: 1 },
    });
  });

  it("reports request-time failures as INTERNAL GatewayErrors so their messages are kept", () => {
    const op = compileOperation("get", {
      upstream: "GET /users/{id}",
      parameters: { id: { in: "path" } },
    });
    const err = (() => {
      try {
        op.prepare({ id: "../x" });
      } catch (e: unknown) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("INTERNAL");
  });

  it("rejects a header mapping that names a reserved header at compile time", () => {
    expect(() =>
      compileOperation(
        "get",
        {
          upstream: "GET /users",
          parameters: { token: { in: "header", name: "Authorization" } },
        },
        new Set(["authorization"]),
      ),
    ).toThrow(
      /maps to header "Authorization", which is reserved by the driver/,
    );
  });

  it("keeps an upstream name of __proto__ as an own query or header entry", () => {
    const op = compileOperation("get", {
      upstream: "GET /users",
      parameters: {
        a: { in: "query", name: "__proto__" },
        b: { in: "header", name: "__proto__" },
      },
    });
    const call = op.prepare({ a: "qv", b: "hv" });
    expect(Object.hasOwn(call.query ?? {}, "__proto__")).toBe(true);
    expect(call.query?.["__proto__"]).toBe("qv");
    expect(Object.hasOwn(call.headers ?? {}, "__proto__")).toBe(true);
    expect(call.headers?.["__proto__"]).toBe("hv");
  });

  it("treats an omitted input field named like an inherited member as absent", () => {
    const op = compileOperation("get", {
      upstream: "GET /users",
      // Keys named like Object.prototype members lose contextual typing, hence the as const.
      parameters: {
        toString: { in: "query" as const },
        constructor: { in: "header" as const, name: "x-ctor" },
      },
    });
    expect(op.prepare({})).toEqual({ method: "GET", path: "/users" });
    expect(op.prepare({ toString: "own", constructor: "c" })).toEqual({
      method: "GET",
      path: "/users",
      query: { toString: "own" },
      headers: { "x-ctor": "c" },
    });
  });

  it("only treats an own payload property as the body", () => {
    const op = compileOperation("post", { upstream: "POST /users" });
    const inherited = Object.create({
      payload: { from: "prototype" },
    }) as Record<string, unknown>;
    expect(op.prepare(inherited)).toEqual({ method: "POST", path: "/users" });
  });

  it("rejects input fields the operation does not map", () => {
    const op = compileOperation("get", {
      upstream: "GET /users/{id}",
      parameters: { id: { in: "path" } },
    });
    const err = (() => {
      try {
        op.prepare({ id: "u1", SYNTHETIC_FIELD: 1, more: 2 });
      } catch (e: unknown) {
        return e as Error;
      }
      return new Error("did not throw");
    })();
    expect(err.message).toMatch(
      /2 input fields are not mapped to the upstream request$/,
    );
    expect(err.message).not.toContain("SYNTHETIC_FIELD");
  });

  it.each([
    ["a string", "nope"],
    ["null", null],
    ["an array", ["a"]],
  ])("rejects %s as input", (_label, input) => {
    const op = compileOperation("get", { upstream: "GET /users" });
    expect(() => op.prepare(input)).toThrow(/input must be an object/);
  });
});

describe("prepare scalar rules", () => {
  const paths = compileOperation("get", {
    upstream: "GET /users/{id}",
    parameters: { id: { in: "path" } },
  });
  const others = compileOperation("get", {
    upstream: "GET /users",
    parameters: { q: { in: "query" }, h: { in: "header", name: "x-h" } },
  });

  // Falsy scalars are values, not omissions: only undefined and null drop a field.
  it("accepts 0 and false wherever a scalar is taken", () => {
    expect(paths.prepare({ id: 0 }).path).toBe("/users/0");
    expect(paths.prepare({ id: false }).path).toBe("/users/false");
    expect(others.prepare({ q: 0, h: false })).toMatchObject({
      query: { q: 0 },
      headers: { "x-h": "false" },
    });
  });

  // String(NaN) and String(Infinity) would reach the upstream as words.
  it.each([NaN, Infinity, -Infinity])("rejects %p in a path value", (value) => {
    expect(() => paths.prepare({ id: value })).toThrow(
      /path parameter "id" needs a scalar input field "id"/,
    );
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects %p in a query value",
    (value) => {
      expect(() => others.prepare({ q: value })).toThrow(
        /query parameter "q" needs a scalar or array of scalars/,
      );
    },
  );

  it.each([NaN, Infinity, -Infinity])(
    "rejects %p in a header value",
    (value) => {
      expect(() => others.prepare({ h: value })).toThrow(
        /header "x-h" needs a scalar input field "h"/,
      );
    },
  );

  // The client validates header values before sending; this is the shape check that precedes it.
  it.each([
    ["an object", { a: 1 }],
    ["an array", ["a"]],
    ["a function", () => "x"],
  ])("rejects %s as a header value", (_label, value) => {
    const err = (() => {
      try {
        others.prepare({ h: value });
      } catch (e: unknown) {
        return e as GatewayError;
      }
      return new Error("did not throw") as GatewayError;
    })();
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.code).toBe("INTERNAL");
    expect(err.message).toBe(
      'Operation "get": header "x-h" needs a scalar input field "h"',
    );
  });
});

describe("prepare query arrays", () => {
  const op = compileOperation("get", {
    upstream: "GET /items",
    parameters: { ids: { in: "query" } },
  });

  it("takes a mix of scalar types and keeps their order", () => {
    expect(op.prepare({ ids: [1, "a", true, 0, false] }).query).toEqual({
      ids: [1, "a", true, 0, false],
    });
  });

  it("keeps an empty array, which sends no query parameter", () => {
    expect(op.prepare({ ids: [] }).query).toEqual({ ids: [] });
  });

  // Allocated rather than written as a literal or built with `delete`, both of which lint
  // refuses, and `Array.from` would fill the holes that are the point here.
  const withHole = new Array<number>(3);
  withHole[0] = 1;
  withHole[2] = 3;
  const trailingHole = new Array<number>(2);
  trailingHole[0] = 1;

  // `every` skips a sparse array's holes, which would otherwise be sent as "undefined".
  it.each([
    ["a hole", withHole],
    ["a trailing hole", trailingHole],
    ["undefined", [1, undefined]],
    ["null", [1, null]],
    ["a nested array", [[1]]],
    ["an object", [{ a: 1 }]],
    ["NaN", [1, NaN]],
  ])("rejects an array containing %s", (_label, ids) => {
    expect(() => op.prepare({ ids })).toThrow(
      /query parameter "ids" needs a scalar or array of scalars in input field "ids"/,
    );
  });
});

describe("prepare payload semantics", () => {
  const post = compileOperation("post", { upstream: "POST /items" });
  const get = compileOperation("get", { upstream: "GET /items" });

  // A falsy body is a body. Only an absent or undefined payload sends none.
  it.each([
    ["null", null],
    ["false", false],
    ["zero", 0],
    ["an empty string", ""],
  ])("keeps %s as the body on a method that takes one", (_label, payload) => {
    expect(post.prepare({ payload })).toMatchObject({ body: payload });
  });

  it.each([
    ["null", null],
    ["false", false],
    ["zero", 0],
    ["an empty string", ""],
  ])("rejects %s as a body on GET", (_label, payload) => {
    expect(() => get.prepare({ payload })).toThrow(
      /GET requests cannot carry a "payload"/,
    );
  });

  // An explicit undefined is the caller saying there is no body, so neither method objects.
  it("omits an undefined payload rather than sending one", () => {
    expect(post.prepare({ payload: undefined })).not.toHaveProperty("body");
    expect(get.prepare({ payload: undefined })).not.toHaveProperty("body");
  });
});

describe("prepare input ownership", () => {
  it("counts an inherited path field as missing", () => {
    const op = compileOperation("get", {
      upstream: "GET /users/{id}",
      parameters: { id: { in: "path" } },
    });
    const inherited = Object.create({ id: "u1" }) as Record<string, unknown>;
    expect(() => op.prepare(inherited)).toThrow(
      /path parameter "id" needs a scalar input field "id"/,
    );
  });

  // A computed key makes an own property; a plain literal would set the prototype instead.
  it("maps an own __proto__ input field into a null-prototype dictionary", () => {
    const op = compileOperation("get", {
      upstream: "GET /items",
      parameters: { ["__proto__"]: { in: "query" } },
    });
    const call = op.prepare({ ["__proto__"]: "v" });
    expect(Object.hasOwn(call.query ?? {}, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(call.query)).toBeNull();
    expect(call.query).toEqual({ ["__proto__"]: "v" });
  });
});
