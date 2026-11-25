import { describe, expect, it } from "vitest";
import { z } from "zod";

import domain from "../test/fixtures/domain.ts";
import { checkDomain, DomainConfigError } from "./check-domain.ts";
import {
  CONVERTED_PROBLEM,
  NOT_STRICT_PROBLEM,
  UNREADABLE_PROBLEMS,
} from "./input-rules.ts";

function problemsOf(config: unknown): readonly string[] {
  try {
    checkDomain(config);
  } catch (error: unknown) {
    if (error instanceof DomainConfigError) return error.problems;
    throw error;
  }
  return [];
}

function domainWith(routes: unknown) {
  return { name: "domain-a", routes };
}

const {
  "GET /v1/todos": LIST_ROUTE,
  "GET /v1/todos/{id}": GET_ROUTE,
  "POST /v1/todos": POST_ROUTE,
  "DELETE /v1/todos/{id}": DELETE_ROUTE,
} = domain.routes;

// Where checkDomain reports a problem on the fixture's list and get routes.
const LIST_ROUTE_AT = 'routes["GET /v1/todos"]';

const GET_ROUTE_AT = 'routes["GET /v1/todos/{id}"]';

// Every status a route may declare, as the problem for any other lists them.
const RESPONSE_STATUSES = "200, 201, 202, 204, 400, 404, 409, 410, 422, 429";

const ROUTE_FIELDS = "handler, params, query, body, responses";

describe("checkDomain", () => {
  it.each<[string, unknown]>([
    ["the fixture's domain", domain],
    // Both match /v1/todos/archived. Routing gives it to the literal segment.
    [
      "a literal segment where another route has a parameter",
      domainWith({
        "GET /v1/todos/{id}": GET_ROUTE,
        "GET /v1/todos/archived": LIST_ROUTE,
      }),
    ],
  ])("accepts %s", (_case, config) => {
    expect(problemsOf(config)).toEqual([]);
  });

  it.each<[string, unknown, readonly string[]]>([
    [
      "a configuration that is not an object",
      "domain-a",
      ["configuration: invalid type, must be an object"],
    ],
    [
      "a domain field it does not have",
      { ...domainWith({ "GET /v1/todos": LIST_ROUTE }), function: {} },
      ["function: unknown field, must be one of: name, routes"],
    ],
    [
      "a name that is not a string",
      { routes: { "GET /v1/todos": LIST_ROUTE } },
      ["name: invalid type, must be a string"],
    ],
    [
      "routes that are not an object",
      domainWith([]),
      [
        'routes: invalid type, must be an object of routes keyed "<METHOD> /<version>/<path>"',
      ],
    ],
    [
      "no routes",
      domainWith({}),
      ["routes: empty, declare at least one route"],
    ],
    [
      "every problem with the name and a key at once",
      // The params are not checked against a key that cannot be read.
      {
        name: "Domain_A",
        routes: { "get /todos": { ...LIST_ROUTE, params: z.object({}) } },
      },
      [
        "name: invalid format, must be 1 to 32 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen",
        'routes["get /todos"]: invalid method "get", must be one of: GET, POST, PUT, PATCH, DELETE',
        'routes["get /todos"]: missing version, start the path with one, such as /v1',
      ],
    ],
    [
      "keys that differ only in a parameter's name",
      domainWith({
        "GET /v1/todos/{id}": GET_ROUTE,
        "GET /v1/todos/{todoId}": {
          ...GET_ROUTE,
          params: z.object({ todoId: z.string() }),
        },
      }),
      [
        'routes: duplicate routes, parameter names do not tell apart: "GET /v1/todos/{id}", "GET /v1/todos/{todoId}"',
      ],
    ],
    [
      "a route that is not an object",
      domainWith({ "GET /v1/todos": "route" }),
      [`${LIST_ROUTE_AT}: invalid type, must be an object`],
    ],
    [
      "route fields it does not have",
      domainWith({ "GET /v1/todos": { ...LIST_ROUTE, cache: true } }),
      [
        `${LIST_ROUTE_AT}.cache: unknown field, must be one of: ${ROUTE_FIELDS}`,
      ],
    ],
    [
      "a handler that is not a function",
      domainWith({ "GET /v1/todos": { ...LIST_ROUTE, handler: "listTodos" } }),
      [`${LIST_ROUTE_AT}.handler: invalid type, must be a function`],
    ],
    [
      "path parameters without params",
      domainWith({ "GET /v1/todos/{id}": { ...GET_ROUTE, params: undefined } }),
      [`${GET_ROUTE_AT}.params: missing, required by path parameters: {id}`],
    ],
    [
      "params that are not an object schema",
      domainWith({ "GET /v1/todos/{id}": { ...GET_ROUTE, params: {} } }),
      [`${GET_ROUTE_AT}.params: invalid type, must be an object schema`],
    ],
    [
      "params on a key with no path parameter",
      domainWith({
        "GET /v1/todos": {
          ...LIST_ROUTE,
          params: z.object({ id: z.string() }),
        },
      }),
      [
        `${LIST_ROUTE_AT}.params: not allowed, the route key has no path parameters`,
      ],
    ],
    [
      "params that miss a path parameter and add a key",
      domainWith({
        "GET /v1/todos/{id}": {
          ...GET_ROUTE,
          params: z.object({ other: z.string() }),
        },
      }),
      [
        `${GET_ROUTE_AT}.params.id: missing, required by path parameter {id}`,
        `${GET_ROUTE_AT}.params.other: unknown path parameter, must be one of: id`,
      ],
    ],
    [
      "parameters that cannot be read from text",
      domainWith({
        "GET /v1/todos/{id}": {
          ...GET_ROUTE,
          params: z.object({ id: z.coerce.number() }),
          query: z.strictObject({ at: z.date().optional() }),
        },
      }),
      [
        `${GET_ROUTE_AT}.params.id: ${CONVERTED_PROBLEM}`,
        `${GET_ROUTE_AT}.query.at: ${UNREADABLE_PROBLEMS.query}`,
      ],
    ],
    [
      "a query and a body that take fields they do not declare",
      domainWith({
        "GET /v1/todos": {
          ...LIST_ROUTE,
          query: z.object({ done: z.boolean() }),
        },
        "POST /v1/todos": {
          ...POST_ROUTE,
          body: z.object({ title: z.string() }),
        },
      }),
      [
        `${LIST_ROUTE_AT}.query: ${NOT_STRICT_PROBLEM}`,
        `routes["POST /v1/todos"].body: ${NOT_STRICT_PROBLEM}`,
      ],
    ],
    [
      "a query that is not an object schema",
      domainWith({ "GET /v1/todos": { ...LIST_ROUTE, query: {} } }),
      [`${LIST_ROUTE_AT}.query: invalid type, must be an object schema`],
    ],
    [
      "a body that is not a schema",
      domainWith({ "POST /v1/todos": { ...POST_ROUTE, body: {} } }),
      ['routes["POST /v1/todos"].body: invalid type, must be a schema'],
    ],
    [
      "a body on GET and DELETE",
      domainWith({
        "GET /v1/todos": { ...LIST_ROUTE, body: z.strictObject({}) },
        "DELETE /v1/todos/{id}": { ...DELETE_ROUTE, body: z.strictObject({}) },
      }),
      [
        `${LIST_ROUTE_AT}.body: not allowed, a GET route takes no body`,
        'routes["DELETE /v1/todos/{id}"].body: not allowed, a DELETE route takes no body',
      ],
    ],
    [
      "responses that are not an object",
      domainWith({ "GET /v1/todos": { ...LIST_ROUTE, responses: [] } }),
      [
        `${LIST_ROUTE_AT}.responses: invalid type, must be an object of schemas keyed by status`,
      ],
    ],
    [
      "no responses",
      domainWith({ "GET /v1/todos": { ...LIST_ROUTE, responses: {} } }),
      [`${LIST_ROUTE_AT}.responses: empty, declare at least one status`],
    ],
    [
      "a response that is not a schema or null",
      domainWith({ "GET /v1/todos": { ...LIST_ROUTE, responses: { 200: 1 } } }),
      [
        `${LIST_ROUTE_AT}.responses[200]: invalid type, must be a schema, or null for no body`,
      ],
    ],
    [
      "a schema on a status with no body",
      domainWith({
        "GET /v1/todos": { ...LIST_ROUTE, responses: { 204: z.object({}) } },
      }),
      [
        `${LIST_ROUTE_AT}.responses[204]: must be null, a 204 response has no body`,
      ],
    ],
    [
      "each kind of status a route may not declare",
      domainWith({
        "GET /v1/todos": {
          ...LIST_ROUTE,
          responses: { 200: null, 302: null, 403: null, 502: null },
        },
      }),
      [
        `${LIST_ROUTE_AT}.responses[302]: status not allowed, must be one of: ${RESPONSE_STATUSES}`,
        `${LIST_ROUTE_AT}.responses[403]: status not allowed, the app treats a 403 as an expired token`,
        `${LIST_ROUTE_AT}.responses[502]: status not allowed, any handler may return 500, 502, 503 or 504 undeclared`,
      ],
    ],
  ])("refuses %s", (_case, config, problems) => {
    expect(problemsOf(config)).toEqual(problems);
  });
});
