import { describe, expect, it } from "vitest";

import { parseRouteKey } from "./route-key.ts";

const FORMAT_PROBLEM = 'must have the format "<METHOD> /<version>/<path>"';

const VERSION_PROBLEM = "the path must start with a version, such as /v1";

const EMPTY_SEGMENT_PROBLEM =
  "the path must not have an empty segment or end with a slash";

const METHOD_PROBLEM = (method: string) =>
  `"${method}" is not a valid method, must be one of: GET, POST, PUT, PATCH, DELETE`;

const SEGMENT_PROBLEM = (segment: string) =>
  `the segment "${segment}" must be lowercase letters, digits and hyphens starting with a letter, or a parameter such as {id}`;

describe("parseRouteKey", () => {
  it("reads a key into its parts", () => {
    expect(parseRouteKey("DELETE /v1/todos/{id}/links/{linkId}")).toEqual({
      ok: true,
      route: {
        method: "DELETE",
        parameters: ["id", "linkId"],
        shape: "DELETE /v1/todos/{}/links/{}",
      },
    });
  });

  it("gives two keys that differ only in a parameter's name one shape", () => {
    expect(parseRouteKey("GET /v1/todos/{todoId}")).toMatchObject({
      route: { shape: "GET /v1/todos/{}" },
    });
    expect(parseRouteKey("GET /v1/todos/{id}")).toMatchObject({
      route: { shape: "GET /v1/todos/{}" },
    });
  });

  it.each(["GET /v1/example", "POST /v1/push-tokens", "PATCH /v12/a1-b2/{id}"])(
    "takes %s",
    (key) => {
      expect(parseRouteKey(key)).toMatchObject({ ok: true });
    },
  );

  it.each([
    ["get /v1/todos", METHOD_PROBLEM("get")],
    ["GET", FORMAT_PROBLEM],
    ["GET/v1/todos", FORMAT_PROBLEM],
    ["GET  /v1/todos", VERSION_PROBLEM],
    ["GET v1/todos", VERSION_PROBLEM],
    ["GET /todos", VERSION_PROBLEM],
    ["GET /v0/todos", VERSION_PROBLEM],
    ["GET /v01/todos", VERSION_PROBLEM],
    ["GET /v1", "the path must have at least one segment after the version"],
    ["GET /v1/", EMPTY_SEGMENT_PROBLEM],
    ["GET /v1/todos/", EMPTY_SEGMENT_PROBLEM],
    ["GET /v1//todos", EMPTY_SEGMENT_PROBLEM],
    ["GET /v1/{id}/{id}", "the path parameter {id} must appear only once"],
    ["GET /v1/Todos", SEGMENT_PROBLEM("Todos")],
    ["GET /v1/todos?done=true", SEGMENT_PROBLEM("todos?done=true")],
    ["GET /v1/{todo_id}", SEGMENT_PROBLEM("{todo_id}")],
  ])("refuses %s", (key, problem) => {
    expect(parseRouteKey(key)).toEqual({ ok: false, problems: [problem] });
  });

  it("reports every problem with a key, each once", () => {
    expect(parseRouteKey("get /todos//")).toEqual({
      ok: false,
      problems: [METHOD_PROBLEM("get"), VERSION_PROBLEM, EMPTY_SEGMENT_PROBLEM],
    });
  });
});
