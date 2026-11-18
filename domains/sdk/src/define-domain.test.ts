import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import domain from "../test/fixtures/domain.ts";
import { getTodo } from "../test/fixtures/routes/index.ts";
import type { Todo } from "../test/fixtures/schemas.ts";
import {
  CreateTodoSchema,
  TodoListSchema,
  TodoParamsSchema,
  TodoSchema,
} from "../test/fixtures/schemas.ts";
import { checkDomain, DomainConfigError } from "./check-domain.ts";
import { defineDomain } from "./define-domain.ts";
import type { HandlerRejectionCode } from "./errors.ts";
import type {
  DomainConfig,
  DomainRoutes,
  Handler,
  RefinedRoutes,
  RegisteredRouteKey,
  Rejection,
  RouteContext,
  RouteContextOf,
  RouteResult,
  RouteResultOf,
} from "./types.ts";

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

const KEY_PROBLEM = "a route key is '<METHOD> /v<n>/<path>'";

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
  "a path parameter whose schema takes no string": {
    key: "GET /v1/todos/{id}",
    route: { ...GET_ROUTE, params: z.object({ id: z.number() }) },
    at: ["params"],
  },
  "a query parameter whose schema takes no string": {
    key: "GET /v1/todos",
    route: {
      ...LIST_ROUTE,
      query: z.strictObject({ page: z.number().optional() }),
    },
    at: ["query"],
  },
} as const;

// What the types refuse and the check reports, so a configuration that bypassed the types is
// refused as it loads.
const refusedByBoth = {
  "a parameter in the key without params": {
    key: "GET /v1/todos/{id}",
    route: LIST_ROUTE,
    at: ["params"],
    problems: [
      'routes["GET /v1/todos/{id}"].params: the route key has path parameters, so params is required, with the keys id',
    ],
  },
  "params on a key with no parameter": {
    key: "GET /v1/todos",
    route: { ...LIST_ROUTE, params: TodoParamsSchema },
    at: ["params"],
    problems: [
      'routes["GET /v1/todos"].params: the route key has no path parameter, so it takes no params',
    ],
  },
  "params whose keys differ from the key's parameters": {
    key: "GET /v1/todos/{todoId}",
    route: GET_ROUTE,
    at: ["params"],
    problems: [
      "routes[\"GET /v1/todos/{todoId}\"].params: path parameter 'todoId' is missing from params",
      "routes[\"GET /v1/todos/{todoId}\"].params: params key 'id' is not a path parameter",
    ],
  },
  "a query that is not an object": {
    key: "GET /v1/todos",
    route: { ...LIST_ROUTE, query: z.string() },
    at: ["RouteConfig"],
    problems: ['routes["GET /v1/todos"].query: must be a Zod object'],
  },
  "a body on GET": {
    key: "GET /v1/todos",
    route: { ...LIST_ROUTE, body: CreateTodoSchema },
    at: ["body"],
    problems: ['routes["GET /v1/todos"].body: a GET route takes no body'],
  },
  "a status that is not 2xx": {
    key: "GET /v1/todos",
    route: { ...LIST_ROUTE, responses: { 200: TodoListSchema, 404: null } },
    at: ["responses"],
    problems: [
      'routes["GET /v1/todos"].responses[404]: status 404 is not 2xx: a failure is a code in errors',
    ],
  },
  "no responses": {
    key: "GET /v1/todos",
    route: { ...LIST_ROUTE, responses: {} },
    at: ["responses"],
    problems: ['routes["GET /v1/todos"].responses: needs at least one status'],
  },
  "a schema for a status that has no body": {
    key: "DELETE /v1/todos/{id}",
    route: { ...DELETE_ROUTE, responses: { 204: TodoSchema } },
    at: ["responses"],
    problems: [
      'routes["DELETE /v1/todos/{id}"].responses[204]: status 204 has no body, so its schema is null',
    ],
  },
  "a code that is not a route's": {
    key: "GET /v1/todos",
    route: { ...LIST_ROUTE, errors: ["internal"] },
    at: ["RouteConfig"],
    problems: [
      'routes["GET /v1/todos"].errors[0]: "internal" is not one of invalid_request, forbidden, not_found, conflict, unprocessable',
    ],
  },
  "a key that does not follow the grammar": {
    key: "GET /todos",
    route: LIST_ROUTE,
    at: [KEY_PROBLEM],
    problems: [
      'routes["GET /todos"]: the path starts with a version, such as /v1',
    ],
  },
  "a misspelled field, and name or function on a route": {
    key: "GET /v1/todos",
    route: {
      ...LIST_ROUTE,
      erorrs: ["not_found"],
      name: "listTodos",
      function: { memoryMb: 256 },
    },
    at: ["erorrs", "name", "function"],
    problems: [
      'routes["GET /v1/todos"].erorrs: not a route field',
      'routes["GET /v1/todos"].name: not a route field',
      'routes["GET /v1/todos"].function: not a route field',
    ],
  },
} as const;

function check(key: string, route: unknown): () => void {
  return () => {
    checkDomain({ name: "domain-a", routes: { [key]: route } });
  };
}

describe("defineDomain", () => {
  it("returns its argument", () => {
    expect(domain.name).toBe("domain-a");
    expect(Object.keys(domain.routes)).toHaveLength(4);
  });

  it("keeps route keys as literals, and registers them for handlers", () => {
    type Keys =
      | "GET /v1/todos"
      | "GET /v1/todos/{id}"
      | "POST /v1/todos"
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

  it.each(Object.entries(refusedByBoth))(
    "refuses %s as it loads too",
    (_case, { key, route, problems }) => {
      expect(check(key, route)).toThrow(expect.objectContaining({ problems }));
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
      "name: 1 to 32 lowercase letters, digits and hyphens",
    );
  });

  it("takes a name and routes, and no function settings", () => {
    expectTypeOf<keyof DomainConfig>().toEqualTypeOf<"name" | "routes">();
  });
});

describe("Handler", () => {
  it("gives each handler the parts its route declares, and nothing else", () => {
    expectTypeOf<{
      [Key in RegisteredRouteKey]: Exclude<
        keyof RouteContext<Key>,
        "caller" | "reject"
      >;
    }>().toEqualTypeOf<{
      "GET /v1/todos": "query";
      "GET /v1/todos/{id}": "params";
      "POST /v1/todos": "body";
      "DELETE /v1/todos/{id}": "params";
    }>();

    expectTypeOf<RouteContext<"GET /v1/todos">["query"]>().toEqualTypeOf<{
      done?: boolean | undefined;
    }>();
    expectTypeOf<RouteContext<"GET /v1/todos/{id}">["params"]>().toEqualTypeOf<{
      id: string;
    }>();
    expectTypeOf<RouteContext<"POST /v1/todos">["body"]>().toEqualTypeOf<{
      title: string;
    }>();
  });

  it("lets each handler reject with its route's codes and any handler's", () => {
    type RejectCode<Key extends RegisteredRouteKey> = Parameters<
      RouteContext<Key>["reject"]
    >[0];

    expectTypeOf<{
      [Key in RegisteredRouteKey]: Exclude<
        RejectCode<Key>,
        HandlerRejectionCode
      >;
    }>().toEqualTypeOf<{
      "GET /v1/todos": never;
      "GET /v1/todos/{id}": "not_found";
      "POST /v1/todos": "conflict";
      "DELETE /v1/todos/{id}": "not_found";
    }>();
    expectTypeOf<HandlerRejectionCode>().toExtend<
      RejectCode<"GET /v1/todos">
    >();
  });

  it("holds each handler to the results its route declares", () => {
    expectTypeOf<{ status: 200; body: Todo }>().toExtend<
      RouteResult<"GET /v1/todos/{id}">
    >();
    expectTypeOf<{ status: 201; body: Todo }>().not.toExtend<
      RouteResult<"GET /v1/todos/{id}">
    >();
    expectTypeOf<{ status: 204 }>().toExtend<
      RouteResult<"DELETE /v1/todos/{id}">
    >();
    expectTypeOf<{ status: 204; body: object }>().not.toExtend<
      RouteResult<"DELETE /v1/todos/{id}">
    >();
    expectTypeOf<Rejection<"conflict">>().toExtend<
      RouteResult<"POST /v1/todos">
    >();
    expectTypeOf<Rejection<"not_found">>().not.toExtend<
      RouteResult<"POST /v1/todos">
    >();
  });

  it("reads a request as the schema's output and a response as its input", () => {
    const DueSchema = z.object({
      due: z.iso.datetime().transform((value) => new Date(value)),
    });

    interface DueRoute {
      readonly body: typeof DueSchema;
      readonly responses: { readonly 200: typeof DueSchema };
    }

    expectTypeOf<RouteContextOf<DueRoute>["body"]>().toEqualTypeOf<{
      due: Date;
    }>();
    expectTypeOf<{ status: 200; body: { due: string } }>().toExtend<
      RouteResultOf<DueRoute>
    >();
    expectTypeOf<{ status: 200; body: { due: Date } }>().not.toExtend<
      RouteResultOf<DueRoute>
    >();
    expect(DueSchema.parse({ due: "2026-11-18T09:00:00Z" }).due).toBeInstanceOf(
      Date,
    );
  });

  it("accepts an async handler", () => {
    expectTypeOf<
      (
        context: RouteContext<"POST /v1/todos">,
      ) => Promise<{ status: 201; body: Todo }>
    >().toExtend<Handler<"POST /v1/todos">>();
  });
});
