import { assert, describe, expect, it } from "vitest";

import { routeMatcher } from "./route-matcher.ts";

const ROUTES = [
  { method: "GET", path: "/v1/todos" },
  { method: "POST", path: "/v1/todos" },
  { method: "GET", path: "/v1/todos/{id}" },
  { method: "DELETE", path: "/v1/todos/{id}" },
  { method: "GET", path: "/v1/todos/archived" },
  { method: "PATCH", path: "/v1/todos/{id}" },
  { method: "GET", path: "/v1/{list}/items/{id}" },
  { method: "GET", path: "/v1/todos/items/{id}" },
  { method: "GET", path: "/v1/{list}/archived/notes" },
  { method: "GET", path: "/v1/todos/{id}/notes" },
] as const;

const match = routeMatcher(ROUTES);

describe("routeMatcher", () => {
  it("finds the route for a method and path, with its parameters", () => {
    const found = match("GET", "/v1/todos/7");

    assert(found.kind === "route");
    expect(found.route).toBe(ROUTES[2]);
    expect(found.params).toEqual(new Map([["id", "7"]]));
  });

  it("finds a route with no parameters", () => {
    const found = match("POST", "/v1/todos");

    assert(found.kind === "route");
    expect(found.route).toBe(ROUTES[1]);
    expect(found.params).toEqual(new Map());
  });

  it.each([
    ["declared", ROUTES],
    ["reversed", [...ROUTES].reverse()],
  ])(
    "prefers a literal at the first segment where routes differ, in %s order",
    (_order, routes) => {
      const matchIn = routeMatcher(routes);

      expect.soft(matchIn("GET", "/v1/todos/archived")).toMatchObject({
        route: ROUTES[4],
      });
      expect.soft(matchIn("GET", "/v1/todos/items/3")).toMatchObject({
        route: ROUTES[7],
      });
      expect.soft(matchIn("GET", "/v1/todos/archived/notes")).toMatchObject({
        route: ROUTES[9],
      });
    },
  );

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

  it("matches a literal however it is encoded", () => {
    const found = match("GET", "/v1/todos/%61rchived");

    const malformed = match("GET", "/v1/todos/%E0%A4%A");

    assert(found.kind === "route");
    expect(found.route).toBe(ROUTES[4]);

    assert(malformed.kind === "route");
    expect(malformed.params.get("id")).toBe("%E0%A4%A");
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
