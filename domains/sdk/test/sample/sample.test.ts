// The sample domain as a domain's own repository would have it, driven through each route's
// `run`. It calls no gateway: a gateway's client is generated from the gateway's contract, and
// the client's own tests cover it. The package's build test covers the declarations a domain
// installs; typecheck holds the sample to the sources.

import type { RouteRequest } from "@govuk-once/flex-domain-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { route } from "./domain.config.ts";
import { routes } from "./index.ts";
import { store } from "./store.ts";

describe("the sample domain's configuration", () => {
  it("refuses a handler that strays from it", () => {
    void (() =>
      route("GET /v1/todos/:id", ({ params }) => {
        // @ts-expect-error: a path parameter the schema does not declare
        void params.title;
        return { status: 200, body: { id: params.id, title: "", done: true } };
      }));
    // @ts-expect-error: a status the route does not declare
    void (() => route("DELETE /v1/todos/:id", () => ({ status: 200 })));
    // @ts-expect-error: a route the configuration does not declare
    void (() => route("GET /v1/nothing", () => ({ status: 200 })));
  });
});

function token(claims: unknown): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

const CALLER = "user-1";

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: null,
    deadline: Date.now() + 10_000,
    requestId: "req-1",
    ...overrides,
    headers: {
      "x-flex-secure": token({ pairwiseId: CALLER }),
      "x-correlation-id": "corr-1",
      ...overrides.headers,
    },
  };
}

type Key = (typeof routes)[number]["key"];

function run(key: Key, overrides: Partial<RouteRequest> = {}) {
  const route = routes.find((candidate) => candidate.key === key);
  if (route === undefined) throw new Error(`no route ${key}`);
  return route.run(request(overrides));
}

const json = (body: unknown) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const body = (response: { body: string }) =>
  JSON.parse(response.body) as unknown;

describe("the sample domain's routes", () => {
  afterEach(() => {
    store.clear();
  });

  it("answers 401 to a request without a caller token", async () => {
    const response = await run("GET /v1/todos", {
      headers: { "x-flex-secure": "" },
    });
    expect(response.status).toBe(401);
    expect(body(response)).toEqual({
      message: "Unauthorized",
      type: "auth_error",
      code: "unauthorized",
    });
  });

  it("creates, lists, reads and deletes a todo for the caller", async () => {
    const created = await run("POST /v1/todos", json({ title: "Buy milk" }));
    expect(created.status).toBe(201);
    expect(created.headers).toEqual({
      "content-type": "application/json",
      "x-correlation-id": "corr-1",
    });
    expect(body(created)).toEqual({
      id: "todo-1",
      title: "Buy milk",
      done: false,
    });

    const listed = await run("GET /v1/todos");
    expect(body(listed)).toEqual({
      items: [{ id: "todo-1", title: "Buy milk", done: false }],
      page: 1,
    });

    // Another caller has a list of their own.
    const other = await run("GET /v1/todos", {
      headers: { "x-flex-secure": token({ pairwiseId: "user-2" }) },
    });
    expect(body(other)).toEqual({ items: [], page: 1 });

    const read = await run("GET /v1/todos/:id", { params: { id: "todo-1" } });
    expect(read.status).toBe(200);

    const deleted = await run("DELETE /v1/todos/:id", {
      params: { id: "todo-1" },
    });
    expect(deleted).toEqual({
      status: 204,
      headers: { "x-correlation-id": "corr-1" },
      body: "",
    });

    const gone = await run("GET /v1/todos/:id", { params: { id: "todo-1" } });
    expect(gone.status).toBe(404);
    expect(body(gone)).toEqual({
      message: "Not found",
      type: "client_error",
      code: "not_found",
    });
  });

  it("refuses a body the schema does not accept before the handler runs", async () => {
    const response = await run("POST /v1/todos", json({ title: "" }));
    expect(response.status).toBe(400);
    expect(store.list(CALLER)).toEqual([]);
  });

  it("refuses a body that is not sent as JSON", async () => {
    const response = await run("POST /v1/todos", {
      headers: { "content-type": "text/plain" },
      body: "Buy milk",
    });
    expect(response.status).toBe(415);
  });

  it("answers a failure the route declares by its name", async () => {
    await run("POST /v1/todos", json({ title: "Buy milk" }));
    const again = await run("POST /v1/todos", json({ title: "Buy milk" }));
    expect(again.status).toBe(409);
    expect(body(again)).toMatchObject({ code: "conflict" });
  });

  it("gives the handler the query as the schema's output", async () => {
    const page = await run("GET /v1/todos", { query: { page: "2" } });
    expect(body(page)).toEqual({ items: [], page: 2 });
    const invalid = await run("GET /v1/todos", { query: { page: "two" } });
    expect(invalid.status).toBe(400);
  });
});
