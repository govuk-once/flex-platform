import { describe, expect, expectTypeOf, it } from "vitest";

import type { HTTP_METHODS } from "./route-key.ts";
import { parseRouteKey } from "./route-key.ts";
import type { HttpMethod, RouteName } from "./types.ts";

// Each key and the name it derives, read by the parser and by RouteName alike.
const NAMES = {
  "GET /v1/example": "getV1Example",
  "GET /v1/example/{id}": "getV1ExampleById",
  "POST /v1/push-tokens": "postV1PushTokens",
  "DELETE /v1/example/{id}/links/{linkId}": "deleteV1ExampleByIdLinksByLinkId",
  "PATCH /v12/a1-b2": "patchV12A1B2",
} as const;

describe("parseRouteKey", () => {
  it("reads a key into its parts", () => {
    expect(parseRouteKey("DELETE /v1/todos/{id}/links/{linkId}")).toEqual({
      ok: true,
      route: {
        method: "DELETE",
        version: 1,
        path: "/v1/todos/{id}/links/{linkId}",
        parameters: ["id", "linkId"],
        name: "deleteV1TodosByIdLinksByLinkId",
        shape: "DELETE /v1/todos/{}/links/{}",
      },
    });
  });

  it.each(Object.entries(NAMES))("derives %s as %s", (key, name) => {
    expect(parseRouteKey(key)).toMatchObject({ ok: true, route: { name } });
  });

  it("derives the same names in the types", () => {
    expectTypeOf<{
      [Key in keyof typeof NAMES]: RouteName<Key>;
    }>().toEqualTypeOf<typeof NAMES>();
  });

  it("gives two keys that differ only in a parameter's name one shape", () => {
    expect(parseRouteKey("GET /v1/todos/{todoId}")).toMatchObject({
      route: { shape: "GET /v1/todos/{}" },
    });
    expect(parseRouteKey("GET /v1/todos/{id}")).toMatchObject({
      route: { shape: "GET /v1/todos/{}" },
    });
  });

  it.each([
    [
      "get /v1/todos",
      "a route key starts with GET, POST, PUT, PATCH or DELETE, then one space",
    ],
    ["GET  /v1/todos", "the path starts with a version, such as /v1"],
    ["GET v1/todos", "the path starts with a version, such as /v1"],
    ["GET /todos", "the path starts with a version, such as /v1"],
    ["GET /v0/todos", "the path starts with a version, such as /v1"],
    ["GET /v01/todos", "the path starts with a version, such as /v1"],
    ["GET /v1", "the path has at least one segment after the version"],
    ["GET /v1/", "the path has an empty segment or ends with a slash"],
    ["GET /v1/todos/", "the path has an empty segment or ends with a slash"],
    ["GET /v1//todos", "the path has an empty segment or ends with a slash"],
    ["GET /v1/{id}/{id}", "the path parameter {id} appears twice"],
    [
      "GET /v1/Todos",
      'the segment "Todos" is not lowercase letters, digits and hyphens starting with a letter, or a parameter such as {id}',
    ],
    [
      "GET /v1/todos?done=true",
      'the segment "todos?done=true" is not lowercase letters, digits and hyphens starting with a letter, or a parameter such as {id}',
    ],
    [
      "GET /v1/{todo_id}",
      'the segment "{todo_id}" is not lowercase letters, digits and hyphens starting with a letter, or a parameter such as {id}',
    ],
  ])("refuses %s", (key, problem) => {
    expect(parseRouteKey(key)).toEqual({ ok: false, problems: [problem] });
  });

  it("reports every problem with a key, each once", () => {
    expect(parseRouteKey("get /todos//")).toEqual({
      ok: false,
      problems: [
        "a route key starts with GET, POST, PUT, PATCH or DELETE, then one space",
        "the path starts with a version, such as /v1",
        "the path has an empty segment or ends with a slash",
      ],
    });
  });

  it("knows every method the types allow", () => {
    expectTypeOf<(typeof HTTP_METHODS)[number]>().toEqualTypeOf<HttpMethod>();
  });
});
