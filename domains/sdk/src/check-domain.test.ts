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
const RESPONSE_STATUSES =
  "200, 201, 202, 203, 204, 205, 206, 207, 208, 226, 400, 402, 404, 409, 410, 412, 413, 422, 423, 424, 425, 428, 429, 451";

const ROUTE_FIELDS =
  "handler, operationId, description, params, query, body, responses, log";

const INPUT_PATH_PROBLEM =
  'invalid path, must be a dot path, such as "params.id" or "body.items.*.status"';

const OUTPUT_PATH_PROBLEM =
  'invalid path, must be a dot path, such as "id" or "items.*.status"';

describe("checkDomain", () => {
  it.each<[string, unknown]>([
    ["the fixture's domain", domain],
    [
      "a domain and route with no description, or a blank one",
      {
        name: "domain-a",
        description: " ",
        routes: { "GET /v1/todos": { ...LIST_ROUTE, description: undefined } },
      },
    ],
    // Both match /v1/todos/archived. Routing gives it to the literal segment.
    [
      "a literal segment where another route has a parameter",
      domainWith({
        "GET /v1/todos/{id}": GET_ROUTE,
        "GET /v1/todos/archived": LIST_ROUTE,
      }),
    ],
    [
      "an operationId on some routes and not others",
      domainWith({
        "GET /v1/todos": LIST_ROUTE,
        "GET /v1/todos/{id}": { ...GET_ROUTE, operationId: undefined },
      }),
    ],
    [
      "log paths that name scalar fields",
      domainWith({
        "GET /v1/todos": {
          ...LIST_ROUTE,
          log: { input: ["query.done"], output: ["items.*.done"] },
        },
        "GET /v1/todos/{id}": {
          ...GET_ROUTE,
          log: { input: ["params.id"], output: ["id", "error.code"] },
        },
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
      ["function: unknown field, must be one of: name, description, routes"],
    ],
    [
      "a name that is not a string",
      { routes: { "GET /v1/todos": LIST_ROUTE } },
      ["name: invalid type, must be a string"],
    ],
    [
      "a description that is not a string",
      {
        ...domainWith({ "GET /v1/todos": { ...LIST_ROUTE, description: 7 } }),
        description: 7,
      },
      [
        "description: invalid type, must be a string",
        `${LIST_ROUTE_AT}.description: invalid type, must be a string`,
      ],
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
          operationId: "getTodoById",
          params: z.object({ todoId: z.string() }),
        },
      }),
      [
        'routes: duplicate routes, parameter names do not tell apart: "GET /v1/todos/{id}", "GET /v1/todos/{todoId}"',
      ],
    ],
    [
      "two routes with one operationId",
      domainWith({
        "GET /v1/todos": { ...LIST_ROUTE, operationId: "getTodo" },
        "GET /v1/todos/{id}": GET_ROUTE,
      }),
      [
        'routes: duplicate operationId "getTodo", used by: "GET /v1/todos", "GET /v1/todos/{id}"',
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
      "a malformed operationId",
      domainWith({
        "GET /v1/todos": { ...LIST_ROUTE, operationId: "List-Todos" },
      }),
      [
        `${LIST_ROUTE_AT}.operationId: invalid format, must be camelCase letters and digits, such as "myExample"`,
      ],
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
    [
      "log paths that name no scalar field",
      domainWith({
        "GET /v1/todos/{id}": {
          ...GET_ROUTE,
          log: {
            input: ["params.id", "params", "body.title", "params..id"],
            output: ["id", "missing", 7],
            level: "debug",
          },
        },
      }),
      [
        `${GET_ROUTE_AT}.log.level: unknown field, must be one of: input, output`,
        `${GET_ROUTE_AT}.log.input[1]: "params" not a scalar field, must name one in params, query or body`,
        `${GET_ROUTE_AT}.log.input[2]: "body.title" not a scalar field, must name one in params, query or body`,
        `${GET_ROUTE_AT}.log.input[3]: ${INPUT_PATH_PROBLEM}`,
        `${GET_ROUTE_AT}.log.output[1]: "missing" not a scalar field, must name one in a declared response`,
        `${GET_ROUTE_AT}.log.output[2]: ${OUTPUT_PATH_PROBLEM}`,
      ],
    ],
    [
      "a log that is not an object, and log paths that are not an array",
      domainWith({
        "GET /v1/todos": { ...LIST_ROUTE, log: [] },
        "GET /v1/todos/{id}": { ...GET_ROUTE, log: { input: "params.id" } },
      }),
      [
        `${LIST_ROUTE_AT}.log: invalid type, must be an object with input, output or both`,
        `${GET_ROUTE_AT}.log.input: invalid type, must be an array of dot paths, such as ["params.id", "body.items.*.status"]`,
      ],
    ],
  ])("refuses %s", (_case, config, problems) => {
    expect(problemsOf(config)).toEqual(problems);
  });
});
