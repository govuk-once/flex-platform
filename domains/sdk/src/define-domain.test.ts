import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import domain from "../test/fixtures/domain.ts";
import { getTodo } from "../test/fixtures/routes/get-todo.ts";
import {
  CreateTodoSchema,
  TodoListSchema,
  TodoParamsSchema,
  TodoSchema,
} from "../test/fixtures/schemas.ts";
import { checkDomain, DomainConfigError } from "./check-domain.ts";
import { defineDomain } from "./define-domain.ts";
import type { RESPONSE_STATUS_CODES } from "./http.ts";
import type { RefinedRoutes } from "./refine.ts";
import type { RegisteredRouteKey } from "./register.ts";
import type { DomainConfig, DomainRoutes, Join, RouteConfig } from "./types.ts";

// Where defineDomain refuses a route: the fields its checks put a problem on, or `never` for a
// route it takes. A case is held to where it is refused, not only to being refused, so one that
// is wrong in two ways cannot pass on the second when the first check stops working. A route
// that is not a RouteConfig at all never reaches the checks.
type RefusedAt<Key extends string, Route> =
  Record<Key, Route> extends DomainRoutes
    ? keyof RefinedRoutes<Record<Key, Route>>[Key]
    : "RouteConfig";

interface RouteCase {
  readonly key: string;
  readonly route: unknown;
  readonly at: readonly string[];
}

type RefusedAtEach<Cases extends Record<string, RouteCase>> = {
  [Case in keyof Cases]: RefusedAt<Cases[Case]["key"], Cases[Case]["route"]>;
};

type Expected<Cases extends Record<string, RouteCase>> = {
  [Case in keyof Cases]: Cases[Case]["at"][number];
};

const ROUTE_KEY_PROBLEM =
  'invalid route key, must be "<METHOD> /<version>/<path>"';

// Each case is one of the fixture's routes with one thing wrong.
const { routes } = domain;

const {
  "GET /v1/todos": LIST_ROUTE,
  "GET /v1/todos/{id}": GET_ROUTE,
  "POST /v1/todos": POST_ROUTE,
  "DELETE /v1/todos/{id}": DELETE_ROUTE,
} = routes;

// What only the types can see: the route a handler was typed for, and the type a schema takes.
const refusedByTypes = {
  "a handler typed for another route": {
    key: "POST /v1/todos",
    route: { ...POST_ROUTE, handler: getTodo },
    at: ["handler"],
  },
  "a handler typed for no route": {
    key: "GET /v1/todos",
    route: {
      ...LIST_ROUTE,
      handler: () => ({ status: 200, body: { items: [] } }),
    },
    at: ["handler"],
  },
} as const;

// What the types refuse and the check refuses too, so a configuration that bypassed the types is
// refused as it loads. check-domain.test.ts holds what the check reports for each.
const refusedByBoth = {
  "a parameter in the key without params": {
    key: "GET /v1/todos/{id}",
    route: LIST_ROUTE,
    at: ["params"],
  },
  "params on a key with no parameter": {
    key: "GET /v1/todos",
    route: { ...LIST_ROUTE, params: TodoParamsSchema },
    at: ["params"],
  },
  "params whose keys differ from the key's parameters": {
    key: "GET /v1/todos/{todoId}",
    route: GET_ROUTE,
    at: ["params"],
  },
  "a query that is not an object": {
    key: "GET /v1/todos",
    route: { ...LIST_ROUTE, query: z.string() },
    at: ["RouteConfig"],
  },
  "a path parameter that converts its input": {
    key: "GET /v1/todos/{id}",
    route: { ...GET_ROUTE, params: z.object({ id: z.coerce.number() }) },
    at: ["params"],
  },
  "an optional path parameter": {
    key: "GET /v1/todos/{id}",
    route: { ...GET_ROUTE, params: z.object({ id: z.string().optional() }) },
    at: ["params"],
  },
  "a query parameter that converts its input": {
    key: "GET /v1/todos",
    route: {
      ...LIST_ROUTE,
      query: z.strictObject({ page: z.coerce.number().optional() }),
    },
    at: ["query"],
  },
  "a query parameter that is an object": {
    key: "GET /v1/todos",
    route: {
      ...LIST_ROUTE,
      query: z.strictObject({ page: z.strictObject({ size: z.number() }) }),
    },
    at: ["query"],
  },
  "a body on GET": {
    key: "GET /v1/todos",
    route: { ...LIST_ROUTE, body: CreateTodoSchema },
    at: ["body"],
  },
  "a status the app reads as an expired token": {
    key: "GET /v1/todos",
    route: { ...LIST_ROUTE, responses: { 200: TodoListSchema, 403: null } },
    at: ["responses"],
  },
  "a 5xx status": {
    key: "GET /v1/todos",
    route: { ...LIST_ROUTE, responses: { 200: TodoListSchema, 502: null } },
    at: ["responses"],
  },
  "no responses": {
    key: "GET /v1/todos",
    route: { ...LIST_ROUTE, responses: {} },
    at: ["responses"],
  },
  "a schema for a status that has no body": {
    key: "DELETE /v1/todos/{id}",
    route: { ...DELETE_ROUTE, responses: { 204: TodoSchema } },
    at: ["responses"],
  },
  "a key that does not follow the grammar": {
    key: "GET /todos",
    route: LIST_ROUTE,
    at: [ROUTE_KEY_PROBLEM],
  },
  "errors, a name or function on a route": {
    key: "GET /v1/todos",
    route: {
      ...LIST_ROUTE,
      errors: ["not_found"],
      name: "listTodos",
      function: { memoryMb: 256 },
    },
    at: ["errors", "name", "function"],
  },
} as const;

function check(key: string, route: unknown): () => void {
  return () => {
    checkDomain({ name: "domain-a", routes: { [key]: route } });
  };
}

describe("defineDomain", () => {
  it("returns its argument", () => {
    const config = {
      name: "domain-a",
      routes: { "GET /v1/todos": LIST_ROUTE },
    };

    expect(defineDomain(config)).toBe(config);
  });

  it("keeps route keys as literals, and registers them for handlers", () => {
    type Keys =
      | "GET /v1/todos"
      | "GET /v1/todos/{id}"
      | "POST /v1/todos"
      | "PATCH /v1/todos/{id}"
      | "DELETE /v1/todos/{id}";

    expectTypeOf<keyof (typeof domain)["routes"]>().toEqualTypeOf<Keys>();
    expectTypeOf<RegisteredRouteKey>().toEqualTypeOf<Keys>();
  });

  it("accepts the fixture's routes, and the types refuse each mistake", () => {
    type ByTypes = typeof refusedByTypes;
    type ByBoth = typeof refusedByBoth;

    expectTypeOf<{
      [Key in keyof typeof routes]: RefusedAt<Key, (typeof routes)[Key]>;
    }>().toEqualTypeOf<{ [Key in keyof typeof routes]: never }>();
    expectTypeOf<RefusedAtEach<ByTypes>>().toEqualTypeOf<Expected<ByTypes>>();
    expectTypeOf<RefusedAtEach<ByBoth>>().toEqualTypeOf<Expected<ByBoth>>();
  });

  it("accepts path and query parameters of each type the SDK reads from text", () => {
    const params = z.object({ id: z.number() });

    const query = z.strictObject({
      tag: z.array(z.string()).optional(),
      archived: z.boolean().default(false),
      size: z.enum(["small", "large"]).optional(),
    });

    const route = { ...GET_ROUTE, params, query };

    expectTypeOf<
      RefusedAt<"GET /v1/todos/{id}", typeof route>
    >().toEqualTypeOf<never>();
    expect(check("GET /v1/todos/{id}", route)).not.toThrow();
  });

  it("explains each refused status, naming the accepted ones from their constant", () => {
    type ResponsesProblem<Responses extends RouteConfig["responses"]> =
      RefinedRoutes<
        Record<"GET /v1/todos", { handler: object; responses: Responses }>
      >["GET /v1/todos"] extends { readonly responses: infer Problem }
        ? keyof Problem
        : never;

    type Accepted = Join<typeof RESPONSE_STATUS_CODES, ", ">;

    expectTypeOf<
      ResponsesProblem<{ 200: null; 302: null }>
    >().toEqualTypeOf<`status 302 not allowed, must be one of: ${Accepted}`>();
    expectTypeOf<
      ResponsesProblem<{ 200: null; 403: null }>
    >().toEqualTypeOf<"status 403 not allowed, the app treats it as an expired token">();
    expectTypeOf<
      ResponsesProblem<{ 200: null; 502: null }>
    >().toEqualTypeOf<"status 502 not allowed, any handler may return 500, 502, 503 or 504 undeclared">();
  });

  it.each(Object.entries(refusedByBoth))(
    "refuses %s as it loads too",
    (_case, { key, route }) => {
      expect(check(key, route)).toThrow(DomainConfigError);
    },
  );

  it.each(Object.entries(refusedByTypes))(
    "leaves %s to the types",
    (_case, { key, route }) => {
      expect(check(key, route)).not.toThrow();
    },
  );

  it("throws every problem the check finds, so a configuration is checked as it loads", () => {
    const define = () => defineDomain({ ...domain, name: "Domain_A" });

    expect(define).toThrow(DomainConfigError);
    expect(define).toThrow(
      "name: invalid format, must be 1 to 32 lowercase letters",
    );
  });

  it("takes a name, a description and routes, and no function settings", () => {
    expectTypeOf<keyof DomainConfig>().toEqualTypeOf<
      "name" | "description" | "routes"
    >();
  });
});
