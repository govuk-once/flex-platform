import { describe, expect, it } from "vitest";
import { z } from "zod";

import domain from "../test/fixtures/domain.ts";
import { checkDomain, DomainConfigError } from "./check-domain.ts";

function problemsOf(config: unknown): readonly string[] {
  try {
    checkDomain(config);
  } catch (error: unknown) {
    if (error instanceof DomainConfigError) return error.problems;
    throw error;
  }
  return [];
}

const {
  "GET /v1/todos": LIST_ROUTE,
  "GET /v1/todos/{id}": GET_ROUTE,
  "DELETE /v1/todos/{id}": DELETE_ROUTE,
} = domain.routes;

const NAME_RULE =
  "1 to 32 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen";

describe("checkDomain", () => {
  it("finds nothing wrong with the fixture's domain", () => {
    expect(problemsOf(domain)).toEqual([]);
  });

  it.each<[string, unknown, readonly string[]]>([
    [
      "keys for the same method and path",
      {
        name: "domain-a",
        routes: {
          "GET /v1/todos/{id}": GET_ROUTE,
          "GET /v1/todos/{todoId}": {
            ...GET_ROUTE,
            params: z.object({ todoId: z.string() }),
          },
          "GET /v1/todos/{key}": {
            ...GET_ROUTE,
            params: z.object({ key: z.string() }),
          },
        },
      },
      [
        'routes: these keys match the same requests, because a path parameter\'s name does not distinguish routes: "GET /v1/todos/{id}", "GET /v1/todos/{todoId}", "GET /v1/todos/{key}"',
      ],
    ],
    [
      "a name that is not a platform name",
      { name: "Domain_A", routes: { "GET /v1/todos": LIST_ROUTE } },
      [`name: "Domain_A" must be ${NAME_RULE}`],
    ],
    [
      "a name that is not a string",
      { routes: { "GET /v1/todos": LIST_ROUTE } },
      [`name: must be a string of ${NAME_RULE}`],
    ],
    [
      "a field the domain does not have",
      {
        name: "domain-a",
        function: { memoryMb: 256 },
        routes: { "GET /v1/todos": LIST_ROUTE },
      },
      ["function: is not a domain field; accepted fields: name, routes"],
    ],
    [
      "no routes",
      { name: "domain-a", routes: {} },
      ["routes: must declare at least one route"],
    ],
    [
      "routes that are not an object",
      { name: "domain-a", routes: [] },
      [
        'routes: must be an object of routes, each keyed "<METHOD> /<version>/<path>"',
      ],
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
      [
        'routes["GET /v1/todos/{id}"].errors[1]: "not_found" is already listed at errors[0]',
      ],
    ],
    [
      "every problem at once",
      { name: "", routes: { "get /todos": LIST_ROUTE } },
      [
        `name: "" must be ${NAME_RULE}`,
        'routes["get /todos"]: "get" is not a valid method, must be one of: GET, POST, PUT, PATCH, DELETE',
        'routes["get /todos"]: the path must start with a version, such as /v1',
      ],
    ],
    [
      "a route that is not an object",
      { name: "domain-a", routes: { "GET /v1/todos": "route" } },
      ['routes["GET /v1/todos"]: must be an object'],
    ],
    [
      "a field the route does not have",
      {
        name: "domain-a",
        routes: { "GET /v1/todos": { ...LIST_ROUTE, cache: true } },
      },
      [
        'routes["GET /v1/todos"].cache: is not a route field; accepted fields: handler, params, query, body, responses, errors',
      ],
    ],
    [
      "path parameters without params",
      {
        name: "domain-a",
        routes: { "GET /v1/todos/{id}": { ...GET_ROUTE, params: undefined } },
      },
      [
        'routes["GET /v1/todos/{id}"].params: is required, with the route key\'s path parameters: {id}',
      ],
    ],
    [
      "params that are not a Zod object",
      {
        name: "domain-a",
        routes: { "GET /v1/todos/{id}": { ...GET_ROUTE, params: {} } },
      },
      ['routes["GET /v1/todos/{id}"].params: must be a Zod object'],
    ],
    [
      "params on a route key with no path parameter",
      {
        name: "domain-a",
        routes: {
          "GET /v1/todos": {
            ...LIST_ROUTE,
            params: z.object({ id: z.string() }),
          },
        },
      },
      [
        'routes["GET /v1/todos"].params: must be left out, as the route key has no path parameter',
      ],
    ],
    [
      "params that miss a path parameter and add a key",
      {
        name: "domain-a",
        routes: {
          "GET /v1/todos/{id}": {
            ...GET_ROUTE,
            params: z.object({ other: z.string() }),
          },
        },
      },
      [
        'routes["GET /v1/todos/{id}"].params: is missing the key for the path parameter {id}',
        'routes["GET /v1/todos/{id}"].params.other: is not a path parameter; accepted keys: id',
      ],
    ],
    [
      "params on a route whose key is not valid",
      {
        name: "domain-a",
        routes: { "get /v1/todos": { ...LIST_ROUTE, params: z.object({}) } },
      },
      [
        'routes["get /v1/todos"]: "get" is not a valid method, must be one of: GET, POST, PUT, PATCH, DELETE',
      ],
    ],
    [
      "a query that is not a Zod object",
      {
        name: "domain-a",
        routes: { "GET /v1/todos": { ...LIST_ROUTE, query: {} } },
      },
      ['routes["GET /v1/todos"].query: must be a Zod object'],
    ],
    [
      "a query that takes fields it does not name",
      {
        name: "domain-a",
        routes: {
          "GET /v1/todos": {
            ...LIST_ROUTE,
            query: z.object({ done: z.string() }),
          },
        },
      },
      [expect.stringContaining('routes["GET /v1/todos"].query')],
    ],
    [
      "a body that is not a Zod schema",
      {
        name: "domain-a",
        routes: {
          "POST /v1/todos": {
            handler: LIST_ROUTE.handler,
            body: {},
            responses: { 200: null },
          },
        },
      },
      ['routes["POST /v1/todos"].body: must be a Zod schema'],
    ],
    [
      "a body on a GET route",
      {
        name: "domain-a",
        routes: {
          "GET /v1/todos": { ...LIST_ROUTE, body: z.strictObject({}) },
        },
      },
      [
        'routes["GET /v1/todos"].body: must be left out, as a GET route takes no body',
      ],
    ],
    [
      "a body on a DELETE route",
      {
        name: "domain-a",
        routes: {
          "DELETE /v1/todos/{id}": {
            ...DELETE_ROUTE,
            body: z.strictObject({}),
          },
        },
      },
      [
        'routes["DELETE /v1/todos/{id}"].body: must be left out, as a DELETE route takes no body',
      ],
    ],
    [
      "a body that takes fields it does not name",
      {
        name: "domain-a",
        routes: {
          "POST /v1/todos": {
            handler: LIST_ROUTE.handler,
            body: z.object({ title: z.string() }),
            responses: { 201: null },
          },
        },
      },
      [expect.stringContaining('routes["POST /v1/todos"].body')],
    ],
    [
      "responses that are not an object",
      {
        name: "domain-a",
        routes: { "GET /v1/todos": { ...LIST_ROUTE, responses: [] } },
      },
      [
        'routes["GET /v1/todos"].responses: must be an object of schemas keyed by status',
      ],
    ],
    [
      "responses with no status",
      {
        name: "domain-a",
        routes: { "GET /v1/todos": { ...LIST_ROUTE, responses: {} } },
      },
      ['routes["GET /v1/todos"].responses: must declare at least one status'],
    ],
    [
      "a status that is not 2xx",
      {
        name: "domain-a",
        routes: {
          "GET /v1/todos": { ...LIST_ROUTE, responses: { 404: null } },
        },
      },
      [
        'routes["GET /v1/todos"].responses[404]: is not a success status; accepted statuses: 2xx, with a failure as a code in errors',
      ],
    ],
    [
      "a schema on a status with no body",
      {
        name: "domain-a",
        routes: {
          "GET /v1/todos": {
            ...LIST_ROUTE,
            responses: { 204: z.object({}) },
          },
        },
      },
      [
        'routes["GET /v1/todos"].responses[204]: must be null, as a 204 response has no body',
      ],
    ],
    [
      "errors that are not a list",
      {
        name: "domain-a",
        routes: { "GET /v1/todos": { ...LIST_ROUTE, errors: "not_found" } },
      },
      ['routes["GET /v1/todos"].errors: must be a list of codes'],
    ],
    [
      "codes a route may not list",
      {
        name: "domain-a",
        routes: { "GET /v1/todos": { ...LIST_ROUTE, errors: ["internal", 7] } },
      },
      [
        'routes["GET /v1/todos"].errors[0]: "internal" must not be listed, as any handler may reject with it',
        'routes["GET /v1/todos"].errors[1]: 7 is not a route code; accepted codes: invalid_request, forbidden, not_found, conflict, unprocessable',
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
});
