import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import domain from "../test/fixtures/domain.ts";
import {
  CreateTodoSchema,
  TodoParamsSchema,
  TodoQuerySchema,
  TodoSchema,
} from "../test/fixtures/schemas.ts";
import { DomainConfigError } from "./check-domain.ts";
import { ErrorBodySchema } from "./errors.ts";
import { openApiRoutes } from "./openapi-routes.ts";

const routes = openApiRoutes(domain);

const {
  "GET /v1/todos": LIST_ROUTE,
  "GET /v1/todos/{id}": GET_ROUTE,
  "POST /v1/todos": POST_ROUTE,
  "DELETE /v1/todos/{id}": DELETE_ROUTE,
} = routes;

// Each definition registered as the server will register it, with a stub that records the routes
// it was called for. The statuses are what Hono answers with; the bodies are the server's to set.
function served(): { app: OpenAPIHono; called: string[] } {
  const app = new OpenAPIHono();

  const called: string[] = [];

  for (const [key, route] of Object.entries(routes)) {
    app.openapi(route, (c) => {
      called.push(key);
      return c.body(null, 204);
    });
  }

  return { app, called };
}

describe("openApiRoutes", () => {
  it("defines each route by its key's method and path, named as the key derives", () => {
    expect(
      Object.fromEntries(
        Object.entries(routes).map(([key, { method, path, operationId }]) => [
          key,
          { method, path, operationId },
        ]),
      ),
    ).toEqual({
      "GET /v1/todos": {
        method: "get",
        path: "/v1/todos",
        operationId: "getV1Todos",
      },
      "GET /v1/todos/{id}": {
        method: "get",
        path: "/v1/todos/{id}",
        operationId: "getV1TodosById",
      },
      "POST /v1/todos": {
        method: "post",
        path: "/v1/todos",
        operationId: "postV1Todos",
      },
      "DELETE /v1/todos/{id}": {
        method: "delete",
        path: "/v1/todos/{id}",
        operationId: "deleteV1TodosById",
      },
    });
  });

  it("takes the request parts the route declares, and no others", () => {
    expect(LIST_ROUTE.request).toStrictEqual({ query: TodoQuerySchema });
    expect(GET_ROUTE.request).toStrictEqual({ params: TodoParamsSchema });
    expect(POST_ROUTE.request).toStrictEqual({
      body: {
        required: true,
        content: { "application/json": { schema: CreateTodoSchema } },
      },
    });
  });

  it("answers each success status, and every failure the route can answer with", () => {
    const handlerStatuses = ["500", "502", "503", "504"];

    expect(
      Object.fromEntries(
        Object.entries(routes).map(([key, route]) => [
          key,
          Object.keys(route.responses),
        ]),
      ),
    ).toEqual({
      "GET /v1/todos": ["200", "400", "401", ...handlerStatuses],
      "GET /v1/todos/{id}": ["200", "400", "401", "404", ...handlerStatuses],
      "POST /v1/todos": ["201", "400", "401", "409", "415", ...handlerStatuses],
      "DELETE /v1/todos/{id}": ["204", "400", "401", "404", ...handlerStatuses],
    });
  });

  it("gives a success its schema, and a status with no body no content", () => {
    const { 201: created } = POST_ROUTE.responses;
    const { 204: deleted } = DELETE_ROUTE.responses;

    expect(created).toStrictEqual({
      description: "Created",
      content: { "application/json": { schema: TodoSchema } },
    });
    expect(deleted).toStrictEqual({ description: "No content" });
  });

  it("answers every failure with the error body", () => {
    for (const route of Object.values(routes)) {
      for (const [status, response] of Object.entries(route.responses)) {
        if (Number(status) < 400) continue;

        expect(response).toStrictEqual({
          description: expect.any(String) as string,
          content: { "application/json": { schema: ErrorBodySchema } },
        });
      }
    }

    const { 404: notFound } = GET_ROUTE.responses;

    expect(notFound).toMatchObject({ description: "Not found" });
  });

  it("lets a request its schemas take reach the handler", async () => {
    const { app, called } = served();

    await app.request("/v1/todos/todo-1");
    await app.request("/v1/todos?done=true");
    await app.request("/v1/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "A todo" }),
    });

    expect(called).toEqual([
      "GET /v1/todos/{id}",
      "GET /v1/todos",
      "POST /v1/todos",
    ]);
  });

  it("refuses a request its schemas refuse before the handler runs", async () => {
    const { app, called } = served();

    const post = (body: unknown, headers?: Record<string, string>) =>
      app.request("/v1/todos", {
        method: "POST",
        ...(headers === undefined ? {} : { headers }),
        body: JSON.stringify(body),
      });

    const json = { "content-type": "application/json" };

    const statuses = await Promise.all([
      app.request("/v1/todos?done=maybe"),
      app.request("/v1/todos?done=true&page=2"),
      post({ title: 1 }, json),
      post({ title: "A todo", done: true }, json),
      post({ title: "A todo" }),
    ]).then((responses) => responses.map(({ status }) => status));

    expect(statuses).toEqual([400, 400, 400, 400, 415]);
    expect(called).toEqual([]);
  });

  it("refuses a key it cannot read", () => {
    const { "GET /v1/todos": route } = domain.routes;

    const define = () =>
      openApiRoutes({ name: "domain-a", routes: { "GET /todos": route } });

    expect(define).toThrow(DomainConfigError);
    expect(define).toThrow(
      'routes["GET /todos"]: the path starts with a version, such as /v1',
    );
  });
});
