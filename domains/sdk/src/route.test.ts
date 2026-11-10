import { GatewayInvocationError } from "@govuk-once/flex-gateway-client";
import * as callerModule from "@govuk-once/flex-gateway-client/caller";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";

import { CALLER_HEADER } from "./caller.ts";
import type { DomainConfig } from "./config.ts";
import { domain } from "./config.ts";
import { currentCaller } from "./context.ts";
import { Failure, fromGatewayError } from "./errors.ts";
import type { RouteRequest } from "./http.ts";
import { log } from "./logging/log.ts";
import { createLogger } from "./logging/logger.ts";
import {
  ANSWER_MARGIN_MS,
  createRouteContextReader,
  createRouteFactory,
  parseRouteKey,
} from "./route.ts";
import type { RouteContext, RouteKey, RouteResult } from "./types.ts";

vi.mock("@govuk-once/flex-gateway-client/caller", async (importOriginal) => {
  const actual = await importOriginal<typeof callerModule>();
  return { ...actual, withCallerContext: vi.fn(actual.withCallerContext) };
});

const Todo = z.object({ id: z.string(), title: z.string() });

const config = {
  name: "todos",
  common: {
    headers: { exampleId: { name: "X-Example-Id", required: false } },
  },
  routes: {
    v1: {
      "/todos": {
        GET: {
          query: z.object({ page: z.string().regex(/^\d+$/).optional() }),
          responses: { 200: z.array(Todo) },
        },
        POST: {
          headers: { userAgent: { name: "User-Agent" } },
          body: Todo.omit({ id: true }),
          responses: { 201: Todo },
          errors: ["conflict"],
        },
      },
      "/todos/:id": {
        GET: {
          params: z.object({ id: z.string().min(1) }),
          responses: { 200: Todo, 204: null },
          errors: ["not_found", "forbidden"],
        },
        DELETE: { responses: { 204: null } },
      },
    },
  },
} as const satisfies DomainConfig;

function token(claims: unknown): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    headers: {
      [CALLER_HEADER]: token({ pairwiseId: "user-1" }),
      "X-Correlation-Id": "corr-1",
      "X-Amzn-Trace-Id": "Root=1-abc;Sampled=1",
    },
    body: null,
    deadline: Date.now() + 10_000,
    requestId: "req-1",
    ...overrides,
  };
}

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(
    "todos",
    {},
    {
      write(line: string) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { lines, logger };
}

const body = (response: { body: string }) =>
  JSON.parse(response.body) as unknown;

describe("parseRouteKey", () => {
  it("splits a key into its method, version and path", () => {
    expect(parseRouteKey("GET /v1/todos/:id")).toEqual({
      method: "GET",
      version: "v1",
      path: "/todos/:id",
    });
  });

  it.each([
    "get /v1/todos",
    "GET v1/todos",
    "GET /v1",
    "GET /v1/",
    "GET //todos",
    "GET /v1/todos extra",
    "GET",
  ])("refuses %j", (key) => {
    expect(() => parseRouteKey(key)).toThrow(/A route's key is/);
  });
});

describe("route", () => {
  beforeEach(() => {
    vi.mocked(callerModule.withCallerContext).mockClear();
  });

  it("refuses a key the configuration does not declare", () => {
    const { logger } = capture();
    const route = createRouteFactory(config, logger);
    expect(() =>
      (route as unknown as (key: string, handler: unknown) => unknown)(
        "GET /v2/todos",
        () => undefined,
      ),
    ).toThrow(/declares no route/);
  });

  it("names its method and path for the router", () => {
    const { logger } = capture();
    const route = createRouteFactory(config, logger);
    const handler = route("GET /v1/todos/:id", () => ({ status: 204 }));
    expect(handler).toMatchObject({
      key: "GET /v1/todos/:id",
      method: "GET",
      path: "/v1/todos/:id",
    });
  });

  it("gives the handler the validated parts, and sends the schema's output", async () => {
    const { logger } = capture();
    const route = createRouteFactory(config, logger);
    const handler = route("GET /v1/todos/:id", (context) => {
      expect(context.params).toEqual({ id: "7" });
      expect(context.headers).toEqual({ exampleId: "ex-1" });
      expect(context.caller).toEqual({ pairwiseId: "user-1" });
      expect(context.correlationId).toBe("corr-1");
      expect(context.signal.aborted).toBe(false);
      return {
        status: 200,
        body: { id: "7", title: "x", secret: "SYNTHETIC_API_KEY" } as z.input<
          typeof Todo
        >,
      };
    });
    const response = await handler.run(
      request({
        params: { id: "7" },
        headers: { ...request().headers, "x-example-id": "ex-1" },
      }),
    );
    expect(response).toEqual({
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "corr-1",
      },
      body: JSON.stringify({ id: "7", title: "x" }),
    });
  });

  it("sets the caller context for the handler, with the margin kept back", async () => {
    const { logger } = capture();
    const route = createRouteFactory(config, logger);
    const deadline = Date.now() + 10_000;
    const handler = route("GET /v1/todos/:id", () => ({ status: 204 }));
    await handler.run(request({ params: { id: "7" }, deadline }));
    expect(callerModule.withCallerContext).toHaveBeenCalledWith(
      {
        deadline: deadline - ANSWER_MARGIN_MS,
        secure: { values: { pairwiseId: "user-1" }, signature: "signature" },
      },
      expect.any(Function),
    );
  });

  it("makes the context reachable from the modules a handler calls", async () => {
    const { logger } = capture();
    const route = createRouteFactory(config, logger);
    const routeContext = createRouteContextReader<typeof config>();
    expect(() => currentCaller()).toThrow(/no request/);
    const handler = route("GET /v1/todos/:id", async (context) => {
      await Promise.resolve();
      expect(currentCaller()).toEqual({ pairwiseId: "user-1" });
      expect(routeContext<"GET /v1/todos/:id">()).toBe(context);
      log.info("from a service module");
      return { status: 204 };
    });
    const response = await handler.run(request({ params: { id: "7" } }));
    expect(response.status).toBe(204);
  });

  it("answers 401 without a readable caller, and the handler is not called", async () => {
    const { lines, logger } = capture();
    const route = createRouteFactory(config, logger);
    const spy = vi.fn(() => ({ status: 204 }) as const);
    const handler = route("GET /v1/todos/:id", spy);
    const response = await handler.run(
      request({
        params: { id: "7" },
        headers: { [CALLER_HEADER]: "placeholder" },
      }),
    );
    expect(response.status).toBe(401);
    expect(body(response)).toEqual({
      message: "Unauthorized",
      type: "auth_error",
      code: "unauthorized",
    });
    expect(spy).not.toHaveBeenCalled();
    expect(lines.at(-1)).toMatchObject({
      level: "warn",
      msg: "caller token missing or unreadable",
      route: "GET /v1/todos/:id",
    });
  });

  it("answers 415 for a body that is not JSON by content type", async () => {
    const { logger } = capture();
    const route = createRouteFactory(config, logger);
    const spy = vi.fn(
      () => ({ status: 201, body: { id: "1", title: "x" } }) as const,
    );
    const handler = route("POST /v1/todos", spy);
    const response = await handler.run(
      request({
        headers: {
          ...request().headers,
          "user-agent": "app",
          "content-type": "text/plain",
        },
        body: JSON.stringify({ title: "x" }),
      }),
    );
    expect(response.status).toBe(415);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["params", { params: { id: "" } }, "GET /v1/todos/:id"],
    ["query", { query: { page: "x" } }, "GET /v1/todos"],
    [
      "headers",
      {
        headers: { ...request().headers, "content-type": "application/json" },
        body: "{}",
      },
      "POST /v1/todos",
    ],
    [
      "body",
      {
        headers: {
          ...request().headers,
          "content-type": "application/json",
          "user-agent": "a",
        },
        body: "{",
      },
      "POST /v1/todos",
    ],
    [
      "body",
      {
        headers: {
          ...request().headers,
          "content-type": "application/json",
          "user-agent": "a",
        },
        body: JSON.stringify({ title: 1 }),
      },
      "POST /v1/todos",
    ],
  ] as const)(
    "answers 400 for invalid %s, naming the part and never the value, and the handler is not called",
    async (part, overrides, key) => {
      const { lines, logger } = capture();
      const route = createRouteFactory(config, logger);
      const spy = vi.fn(() => ({ status: 204 }) as const);
      const handler = (
        route as unknown as (
          key: string,
          handler: unknown,
        ) => {
          run: (r: RouteRequest) => Promise<{ status: number; body: string }>;
        }
      )(key, spy);
      const response = await handler.run(request(overrides));
      expect(response.status).toBe(400);
      expect(body(response)).toEqual({
        message: "Invalid request",
        type: "client_error",
        code: "invalid_request",
      });
      expect(spy).not.toHaveBeenCalled();
      expect(lines.at(-1)).toMatchObject({
        level: "warn",
        msg: "request validation failed",
        part,
        correlationId: "corr-1",
        traceId: "1-abc",
        requestId: "req-1",
      });
      expect(JSON.stringify(lines)).not.toContain("title");
    },
  );

  it("gives an optional header as undefined and a required one as its value", async () => {
    const { logger } = capture();
    const route = createRouteFactory(config, logger);
    const handler = route("POST /v1/todos", ({ headers, body: todo }) => {
      expect(headers).toEqual({ exampleId: undefined, userAgent: "app" });
      return { status: 201, body: { id: "1", ...todo } };
    });
    const response = await handler.run(
      request({
        headers: {
          ...request().headers,
          "User-Agent": "app",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ title: "x", extra: true }),
      }),
    );
    expect(response.status).toBe(201);
    expect(body(response)).toEqual({ id: "1", title: "x" });
  });

  it("answers a declared failure with its status and body", async () => {
    const { logger } = capture();
    const route = createRouteFactory(config, logger);
    const handler = route("GET /v1/todos/:id", ({ fail: failWith }) =>
      failWith("not_found"),
    );
    const response = await handler.run(request({ params: { id: "7" } }));
    expect(response.status).toBe(404);
    expect(body(response)).toEqual({
      message: "Not found",
      type: "client_error",
      code: "not_found",
    });
  });

  it("answers a gateway's error as the mapping says, including one thrown", async () => {
    const { logger } = capture();
    const route = createRouteFactory(config, logger);
    const returned = route("GET /v1/todos/:id", () =>
      fromGatewayError("UPSTREAM_TIMEOUT"),
    );
    expect((await returned.run(request({ params: { id: "7" } }))).status).toBe(
      504,
    );
    const thrown = route("GET /v1/todos/:id", () => {
      throw new Failure("conflict");
    });
    expect((await thrown.run(request({ params: { id: "7" } }))).status).toBe(
      500,
    );
    const invocation = route("GET /v1/todos/:id", () => {
      throw new GatewayInvocationError("function_error", "fixed text");
    });
    expect(
      (await invocation.run(request({ params: { id: "7" } }))).status,
    ).toBe(502);
  });

  it("answers 500 for a failure the route does not declare", async () => {
    const { lines, logger } = capture();
    const route = createRouteFactory(config, logger);
    const handler = route(
      "DELETE /v1/todos/:id",
      () => new Failure("not_found") as never,
    );
    const response = await handler.run(request());
    expect(response.status).toBe(500);
    expect(lines.at(-1)).toMatchObject({
      msg: "handler failed with a code the route does not declare",
      code: "not_found",
    });
  });

  it("answers 500 for a failure only the route decides", async () => {
    const { lines, logger } = capture();
    const route = createRouteFactory(config, logger);
    for (const code of ["unauthorized", "unsupported_media_type"] as const) {
      const returned = route(
        "DELETE /v1/todos/:id",
        () => new Failure(code) as never,
      );
      const response = await returned.run(request());
      expect(response.status).toBe(500);
      expect(body(response)).toMatchObject({ code: "internal" });
      expect(lines.at(-1)).toMatchObject({
        msg: "handler failed with a code the route does not declare",
        code,
      });
      const thrown = route("DELETE /v1/todos/:id", () => {
        throw new Failure(code);
      });
      expect((await thrown.run(request())).status).toBe(500);
    }
  });

  it("answers 500 for a response the route does not declare, or that fails its schema", async () => {
    const { lines, logger } = capture();
    const route = createRouteFactory(config, logger);
    const undeclared = route(
      "DELETE /v1/todos/:id",
      () => ({ status: 200 }) as never,
    );
    expect((await undeclared.run(request())).status).toBe(500);
    expect(lines.at(-1)).toMatchObject({ status: 200 });
    const invalid = route(
      "GET /v1/todos/:id",
      () => ({ status: 200, body: { id: 1 } }) as never,
    );
    expect((await invalid.run(request({ params: { id: "7" } }))).status).toBe(
      500,
    );
    expect(lines.at(-1)).toMatchObject({
      msg: "response validation failed",
      status: 200,
      issues: ["invalid_type", "invalid_type"],
    });
    const withBody = route(
      "DELETE /v1/todos/:id",
      () => ({ status: 204, body: {} }) as never,
    );
    expect((await withBody.run(request())).status).toBe(500);
    const notAResponse = route(
      "DELETE /v1/todos/:id",
      () => undefined as never,
    );
    expect((await notAResponse.run(request())).status).toBe(500);
  });

  it("sends a response with no body as empty, without a content type", async () => {
    const { logger } = capture();
    const route = createRouteFactory(config, logger);
    const handler = route("DELETE /v1/todos/:id", () => ({ status: 204 }));
    expect(await handler.run(request())).toEqual({
      status: 204,
      headers: { "x-correlation-id": "corr-1" },
      body: "",
    });
  });

  it("answers 500 for an error the handler lets out, logging where it came from and not what it said", async () => {
    const { lines, logger } = capture();
    const route = createRouteFactory(config, logger);
    const handler = route("DELETE /v1/todos/:id", () => {
      throw new Error("holds SYNTHETIC_API_KEY");
    });
    const response = await handler.run(request());
    expect(response.status).toBe(500);
    expect(body(response)).toEqual({
      message: "Internal server error",
      type: "server_error",
      code: "internal",
    });
    expect(lines.at(-1)).toMatchObject({
      level: "error",
      msg: "handler failed",
      error: {
        frames: expect.arrayContaining([
          expect.stringContaining("route.test.ts"),
        ]) as unknown,
      },
    });
    expect(JSON.stringify(lines)).not.toContain("SYNTHETIC_API_KEY");

    const thrower = route("DELETE /v1/todos/:id", () => {
      throw "holds SYNTHETIC_API_KEY" as unknown as Error;
    });
    expect((await thrower.run(request())).status).toBe(500);
    expect(lines.at(-1)).toMatchObject({
      msg: "handler failed",
      error: { frames: [] },
    });
    expect(JSON.stringify(lines)).not.toContain("SYNTHETIC_API_KEY");
  });

  it("answers 504 when the deadline passes first, and the signal fires", async () => {
    const { lines, logger } = capture();
    const route = createRouteFactory(config, logger);
    let signal: AbortSignal | undefined;
    const handler = route("DELETE /v1/todos/:id", (context) => {
      signal = context.signal;
      return new Promise<{ status: 204 }>(() => undefined);
    });
    const response = await handler.run(
      request({ deadline: Date.now() + ANSWER_MARGIN_MS + 20 }),
    );
    expect(response.status).toBe(504);
    expect(body(response)).toMatchObject({ code: "timeout" });
    expect(lines.at(-1)).toMatchObject({
      msg: "handler did not answer before the deadline",
    });
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it("answers 504 when the handler fails because its signal fired", async () => {
    const { lines, logger } = capture();
    const route = createRouteFactory(config, logger);
    const handler = route(
      "DELETE /v1/todos/:id",
      ({ signal }) =>
        new Promise<{ status: 204 }>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("stopped")));
        }),
    );
    const response = await handler.run(
      request({ deadline: Date.now() + ANSWER_MARGIN_MS + 20 }),
    );
    expect(response.status).toBe(504);
    expect(lines.at(-1)).toMatchObject({
      msg: "handler did not answer before the deadline",
    });
  });

  it("answers 500 for a request without a deadline", async () => {
    const { logger } = capture();
    const route = createRouteFactory(config, logger);
    const handler = route("DELETE /v1/todos/:id", () => ({ status: 204 }));
    expect((await handler.run(request({ deadline: Number.NaN }))).status).toBe(
      500,
    );
  });

  describe("with a declaration that misbehaves", () => {
    const leak = () => {
      throw new Error("holds SYNTHETIC_API_KEY");
    };
    const awkward = {
      name: "awkward",
      routes: {
        v1: {
          "/throws": {
            GET: {
              query: z.object({ q: z.string().refine(leak) }),
              responses: { 204: null },
            },
          },
          "/answers": {
            GET: {
              responses: {
                200: z.bigint(),
                201: z.string().optional(),
                202: z.string().transform(leak),
              },
            },
          },
        },
      },
    } as const satisfies DomainConfig;

    it("answers 500 for a request schema that throws, and the handler is not called", async () => {
      const { lines, logger } = capture();
      const route = createRouteFactory(awkward, logger);
      const spy = vi.fn(() => ({ status: 204 }) as const);
      const handler = route("GET /v1/throws", spy);
      const response = await handler.run(request({ query: { q: "x" } }));
      expect(response.status).toBe(500);
      expect(body(response)).toMatchObject({ code: "internal" });
      expect(response.headers).toMatchObject({ "x-correlation-id": "corr-1" });
      expect(spy).not.toHaveBeenCalled();
      expect(lines.at(-1)).toMatchObject({
        level: "error",
        msg: "route failed",
        error: { frames: expect.any(Array) as unknown },
      });
      expect(JSON.stringify(lines)).not.toContain("SYNTHETIC_API_KEY");
    });

    it("answers 500 for a response schema that throws", async () => {
      const { lines, logger } = capture();
      const route = createRouteFactory(awkward, logger);
      const handler = route("GET /v1/answers", () => ({
        status: 202,
        body: "x",
      }));
      expect((await handler.run(request())).status).toBe(500);
      expect(lines.at(-1)).toMatchObject({ msg: "route failed" });
      expect(JSON.stringify(lines)).not.toContain("SYNTHETIC_API_KEY");
    });

    it("answers 500 for a body JSON cannot write", async () => {
      const { lines, logger } = capture();
      const route = createRouteFactory(awkward, logger);
      const big = route("GET /v1/answers", () => ({ status: 200, body: 1n }));
      expect((await big.run(request())).status).toBe(500);
      expect(lines.at(-1)).toMatchObject({
        msg: "response body cannot be written as JSON",
        status: 200,
      });
      const none = route("GET /v1/answers", () => ({
        status: 201,
        body: undefined,
      }));
      const response = await none.run(request());
      expect(response.status).toBe(500);
      expect(body(response)).toMatchObject({ code: "internal" });
    });
  });

  it("waits for a deadline further off than a timer can be set for", async () => {
    const { logger } = capture();
    const route = createRouteFactory(config, logger);
    const handler = route("DELETE /v1/todos/:id", ({ signal }) => {
      expect(signal.aborted).toBe(false);
      return { status: 204 };
    });
    const response = await handler.run(
      request({ deadline: Date.now() + 2 ** 33 }),
    );
    expect(response.status).toBe(204);
  });

  it("is built by domain()", () => {
    const todos = domain(config);
    expect(todos.config).toBe(config);
    const handler = todos.route("DELETE /v1/todos/:id", () => ({
      status: 204,
    }));
    expect(handler.key).toBe("DELETE /v1/todos/:id");
    expect(() => todos.routeContext<"DELETE /v1/todos/:id">()).toThrow(
      /no request/,
    );
  });
});

describe("the types", () => {
  type Config = typeof config;

  it("hold a key to the routes declared", () => {
    expectTypeOf<RouteKey<Config>>().toEqualTypeOf<
      | "GET /v1/todos"
      | "POST /v1/todos"
      | "GET /v1/todos/:id"
      | "DELETE /v1/todos/:id"
    >();
    const { route } = domain(config);
    // @ts-expect-error: not a declared route
    void (() => route("PUT /v1/todos", () => ({ status: 204 })));
  });

  it("give the context only what the route declares", () => {
    type Get = RouteContext<Config, "GET /v1/todos/:id">;
    expectTypeOf<Get["params"]>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<Get["headers"]>().toEqualTypeOf<{
      readonly exampleId: string | undefined;
    }>();
    expectTypeOf<Get["caller"]>().toEqualTypeOf<{
      readonly pairwiseId: string;
    }>();
    expectTypeOf<Get>().not.toHaveProperty("query");
    expectTypeOf<Get>().not.toHaveProperty("body");

    type Post = RouteContext<Config, "POST /v1/todos">;
    expectTypeOf<Post["body"]>().toEqualTypeOf<{ title: string }>();
    expectTypeOf<Post["headers"]>().toEqualTypeOf<{
      readonly exampleId: string | undefined;
      readonly userAgent: string;
    }>();
    expectTypeOf<Post>().not.toHaveProperty("params");

    type List = RouteContext<Config, "GET /v1/todos">;
    expectTypeOf<List["query"]>().toEqualTypeOf<{
      page?: string | undefined;
    }>();

    type Remove = RouteContext<Config, "DELETE /v1/todos/:id">;
    expectTypeOf<Remove>().not.toHaveProperty("fail");
    expectTypeOf<Remove>().not.toHaveProperty("params");
  });

  it("hold the result to the statuses and failures declared", () => {
    type Get = RouteResult<Config, "GET /v1/todos/:id">;
    expectTypeOf<{
      status: 200;
      body: { id: string; title: string };
    }>().toExtend<Get>();
    expectTypeOf<{ status: 204 }>().toExtend<Get>();
    expectTypeOf<Failure<"not_found">>().toExtend<Get>();
    expectTypeOf<Failure<"timeout">>().toExtend<Get>();
    expectTypeOf<{
      status: 201;
      body: { id: string; title: string };
    }>().not.toExtend<Get>();
    expectTypeOf<{
      status: 200;
      body: { id: string };
    }>().not.toExtend<Get>();
    expectTypeOf<Failure<"conflict">>().not.toExtend<Get>();

    const { route } = domain(config);
    void (() =>
      route("GET /v1/todos/:id", ({ fail: failWith }) => {
        // @ts-expect-error: the route does not declare conflict
        void failWith("conflict");
        return failWith("forbidden");
      }));
    void (() =>
      // @ts-expect-error: the route does not declare not_found, so a gateway's errors need it
      route("DELETE /v1/todos/:id", () => fromGatewayError("NOT_FOUND")));
  });
});
