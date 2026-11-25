import { assert, describe, expect, it } from "vitest";

import { routeMatcher } from "./route-matcher.ts";

const routes = [
  { method: "GET", path: "/v1/todos" },
  { method: "POST", path: "/v1/todos" },
  { method: "GET", path: "/v1/todos/{id}" },
  { method: "DELETE", path: "/v1/todos/{id}" },
  { method: "GET", path: "/v1/todos/archived" },
  { method: "PATCH", path: "/v1/todos/{id}" },
  { method: "GET", path: "/v1/{list}/items/{id}" },
  { method: "GET", path: "/v1/todos/items/{id}" },
] as const;

const match = routeMatcher(routes);

describe("routeMatcher", () => {
  it("finds the route for a method and path, with its parameters", () => {
    const found = match("GET", "/v1/todos/7");

    assert(found.kind === "route");
    expect(found.route).toBe(routes[2]);
    expect(found.params).toEqual(new Map([["id", "7"]]));
  });

  it("finds a route with no parameters", () => {
    const found = match("POST", "/v1/todos");

    assert(found.kind === "route");
    expect(found.route).toBe(routes[1]);
    expect(found.params).toEqual(new Map());
  });

  it("prefers a literal segment to a parameter, wherever the route is declared", () => {
    const archived = match("GET", "/v1/todos/archived");

    assert(archived.kind === "route");
    expect(archived.route).toBe(routes[4]);

    const items = match("GET", "/v1/todos/items/3");

    assert(items.kind === "route");
    expect(items.route).toBe(routes[7]);
  });

  it("answers with the path's methods, in declared order, when none is the request's", () => {
    expect(match("PUT", "/v1/todos/7")).toEqual({
      kind: "method",
      allowed: ["GET", "DELETE", "PATCH"],
    });
    expect(match("HEAD", "/v1/todos")).toEqual({
      kind: "method",
      allowed: ["GET", "POST"],
    });
  });

  it.each([
    "/v1/todos/7/extra",
    "/v1/todos/",
    "/v1/Todos",
    "/v1/todos//",
    "v1/todos",
    "",
  ])("matches nothing for %j", (path) => {
    expect(match("GET", path)).toEqual({ kind: "none" });
  });

  it("leaves a parameter as it was sent", () => {
    const found = match("GET", "/v1/todos/a%2Fb");

    assert(found.kind === "route");
    expect(found.params.get("id")).toBe("a%2Fb");
  });

  it("refuses two routes that differ only in a parameter's name", () => {
    expect(() =>
      routeMatcher([
        { method: "GET", path: "/v1/todos/{id}" },
        { method: "GET", path: "/v1/todos/{todoId}" },
      ]),
    ).toThrow(
      "GET /v1/todos/{todoId}: duplicate route, matches the same paths as GET /v1/todos/{id}",
    );
  });

  it("takes the same path for two methods", () => {
    expect(() =>
      routeMatcher([
        { method: "GET", path: "/v1/todos/{id}" },
        { method: "DELETE", path: "/v1/todos/{todoId}" },
      ]),
    ).not.toThrow();
  });

  it.each([
    [
      "/v1/{id}/items/{id}/{id}",
      "GET /v1/{id}/items/{id}/{id}: duplicate parameter, name each once: {id}",
    ],
    ["v1/todos", 'GET v1/todos: invalid path, must start with "/"'],
  ])("refuses %s", (path, message) => {
    expect(() => routeMatcher([{ method: "GET", path }])).toThrow(message);
  });
});
