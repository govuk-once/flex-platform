import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import domain from "../test/fixtures/domain.ts";
import type {
  NULL_BODY_STATUS_CODES,
  SUCCESS_STATUS_CODES,
} from "./check-domain.ts";
import { checkDomain, DomainConfigError } from "./check-domain.ts";
import type { NullBodyStatusCode, SuccessStatusCode } from "./types.ts";

function problemsOf(config: unknown): readonly string[] {
  try {
    checkDomain(config);
  } catch (error: unknown) {
    if (error instanceof DomainConfigError) return error.problems;
    throw error;
  }
  return [];
}

const { "GET /v1/todos": LIST_ROUTE, "GET /v1/todos/{id}": GET_ROUTE } =
  domain.routes;

describe("checkDomain", () => {
  it("finds nothing wrong with the fixture's domain", () => {
    expect(problemsOf(domain)).toEqual([]);
  });

  it.each<[string, unknown, readonly string[]]>([
    [
      "two keys for the same method and path",
      {
        name: "domain-a",
        routes: {
          "GET /v1/todos/{id}": GET_ROUTE,
          "GET /v1/todos/{todoId}": {
            ...GET_ROUTE,
            params: z.object({ todoId: z.string() }),
          },
        },
      },
      [
        'routes["GET /v1/todos/{id}"] and routes["GET /v1/todos/{todoId}"]: the same method and path, since a path parameter matches any value',
      ],
    ],
    [
      "two keys that derive the same name",
      {
        name: "domain-a",
        routes: {
          "GET /v1/todo-items": LIST_ROUTE,
          "GET /v1/todo/items": LIST_ROUTE,
        },
      },
      [
        'routes["GET /v1/todo-items"] and routes["GET /v1/todo/items"]: each derives the name "getV1TodoItems"',
      ],
    ],
    [
      "a name that is not a platform name",
      { name: "Domain_A", routes: { "GET /v1/todos": LIST_ROUTE } },
      [
        "name: 1 to 32 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen",
      ],
    ],
    [
      "a field the domain does not have",
      {
        name: "domain-a",
        function: { memoryMb: 256 },
        routes: { "GET /v1/todos": LIST_ROUTE },
      },
      ["function: not a domain field"],
    ],
    [
      "no routes",
      { name: "domain-a", routes: {} },
      ["routes: needs at least one route"],
    ],
    [
      "routes that are not an object",
      { name: "domain-a", routes: [] },
      ["routes: must be an object of routes keyed by route key"],
    ],
    [
      "a handler that is not a function",
      {
        name: "domain-a",
        routes: { "GET /v1/todos": { ...LIST_ROUTE, handler: "listTodos" } },
      },
      ['routes["GET /v1/todos"].handler: must be a function'],
    ],
    [
      "a response that is not a schema",
      {
        name: "domain-a",
        routes: {
          "GET /v1/todos": { ...LIST_ROUTE, responses: { 200: "todos" } },
        },
      },
      [
        'routes["GET /v1/todos"].responses[200]: must be a Zod schema, or null for no body',
      ],
    ],
    [
      "a code listed twice",
      {
        name: "domain-a",
        routes: {
          "GET /v1/todos/{id}": {
            ...GET_ROUTE,
            errors: ["not_found", "not_found"],
          },
        },
      },
      ['routes["GET /v1/todos/{id}"].errors[1]: "not_found" is listed twice'],
    ],
    [
      "every problem at once",
      { name: "", routes: { "get /todos": LIST_ROUTE } },
      [
        "name: 1 to 32 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen",
        'routes["get /todos"]: a route key starts with GET, POST, PUT, PATCH or DELETE, then one space',
        'routes["get /todos"]: the path starts with a version, such as /v1',
      ],
    ],
    [
      "a configuration that is not an object",
      "domain-a",
      ["the configuration must be an object"],
    ],
  ])("refuses %s", (_case, config, problems) => {
    expect(problemsOf(config)).toEqual(problems);
  });

  it("knows every 2xx status the types allow, and which carry no body", () => {
    expectTypeOf<
      (typeof SUCCESS_STATUS_CODES)[number]
    >().toEqualTypeOf<SuccessStatusCode>();
    expectTypeOf<
      (typeof NULL_BODY_STATUS_CODES)[number]
    >().toEqualTypeOf<NullBodyStatusCode>();
  });
});
