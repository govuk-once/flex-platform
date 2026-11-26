import { setTimeout } from "node:timers/promises";

import type { InvocationFailure } from "@govuk-once/flex-gateway-client";
import { GatewayInvocationError } from "@govuk-once/flex-gateway-client";
import * as callerModule from "@govuk-once/flex-gateway-client/caller";
import type { Logger } from "pino";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import domain from "../../test/fixtures/domain.ts";
import { TodoParamsSchema, TodoSchema } from "../../test/fixtures/schemas.ts";
import type { LogLine } from "../../test/fixtures/test-client.ts";
import {
  createTestClient,
  unsignedCallerToken,
} from "../../test/fixtures/test-client.ts";
import { DomainConfigError } from "../check-domain.ts";
import { CALLER_TOKEN_HEADER, CORRELATION_ID_HEADER } from "../http.ts";
import type { DomainConfig, RouteConfig } from "../types.ts";
import { createApp } from "./app.ts";
import { createLogger, REDACTED } from "./logging.ts";

type CallerModule = typeof callerModule;

vi.mock("@govuk-once/flex-gateway-client/caller", async (importOriginal) => {
  const actual = await importOriginal<CallerModule>();

  return { ...actual, withCallerContext: vi.fn(actual.withCallerContext) };
});

const SECRET = "SYNTHETIC_SECRET";

const TRACE_ID = "1-5759e988-bd862e3fe1be46a994272793";

const TEST_ROUTE = "GET /v1/test";

const TODO = { id: "1", title: "Renew", done: false };

// A domain of one route, so a test's handler is written where it is used.
function domainWithHandler(
  handler: RouteConfig["handler"],
  responses: RouteConfig["responses"],
  { key = TEST_ROUTE, ...route }: Partial<RouteConfig> & { key?: string } = {},
): DomainConfig {
  return {
    name: "domain-a",
    routes: { [key]: { ...route, handler, responses } },
  };
}

// A secret sent in a request or returned by a handler never reaches the SDK's own line.
function expectNotLogged(lines: readonly LogLine[], value: string): void {
  expect(JSON.stringify(lines)).not.toContain(value);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("createApp", () => {
  it("refuses a configuration that never passed through defineDomain, as it loads", () => {
    const unchecked: DomainConfig = {
      name: "Domain_A",
      routes: { [TEST_ROUTE]: { handler: () => undefined, responses: {} } },
    };

    expect(() => createTestClient(unchecked)).toThrow(DomainConfigError);
  });

  it("answers a route with its handler's body, as its schema writes it, and logs it at info", async () => {
    const client = createTestClient(
      domainWithHandler(
        () => ({ status: 200, body: { ...TODO, extra: SECRET } }),
        { 200: TodoSchema },
      ),
    );

    const response = await client.get("/v1/test");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-rejected-by")).toBeNull();
    expect(await response.json()).toEqual(TODO);
    expect(client.lines).toEqual([
      expect.objectContaining({
        level: 30,
        name: "domain-a",
        msg: "request: answered by its route",
        route: TEST_ROUTE,
        status: 200,
        durationMs: expect.any(Number) as number,
      }),
    ]);
    expectNotLogged(client.lines, SECRET);
  });

  it("answers a null body status with no body", async () => {
    const client = createTestClient(domain);

    const response = await client.delete("/v1/todos/1");

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-type")).toBeNull();
  });

  it("gives the handler its declared parts, the caller, a signal and a log, and runs it in the caller's context", async () => {
    const handler = vi.fn((_context: Record<string, unknown>) => ({
      status: 204,
    }));

    const client = createTestClient(
      domainWithHandler(
        handler,
        { 204: null },
        { key: "GET /v1/todos/{id}", params: TodoParamsSchema },
      ),
      {
        caller: { pairwiseId: "user-a", pushId: "push-a" },
        remainingTimeMs: 5_000,
      },
    );

    const before = Date.now();

    await client.get("/v1/todos/1");

    const [[context] = []] = handler.mock.calls;

    assert.isDefined(context);

    expect(Object.keys(context).sort()).toEqual([
      "caller",
      "log",
      "params",
      "signal",
    ]);
    expect(context).toMatchObject({
      params: { id: "1" },
      caller: { pairwiseId: "user-a", pushId: "push-a" },
    });

    const [[callerContext] = []] = vi.mocked(callerModule.withCallerContext)
      .mock.calls;

    assert.isDefined(callerContext);

    expect(callerContext.secure?.token).toBe(
      unsignedCallerToken({ pairwiseId: "user-a", pushId: "push-a" }),
    );
    expect(callerContext.deadline).toBeGreaterThanOrEqual(before + 4_500);
    expect(callerContext.deadline).toBeLessThanOrEqual(Date.now() + 4_500);
  });

  it("reads query and path values by their declared types", async () => {
    const client = createTestClient(
      domainWithHandler(
        ({ params, query }: { params: object; query: object }) => ({
          status: 200,
          body: { ...params, ...query },
        }),
        { 200: z.object({ id: z.number(), done: z.boolean() }) },
        {
          key: "GET /v1/todos/{id}",
          params: z.object({ id: z.number() }),
          query: z.strictObject({ done: z.boolean() }),
        },
      ),
    );

    const response = await client.get("/v1/todos/7?done=true");

    const refused = await client.get("/v1/todos/seven?done=true");

    expect(await response.json()).toEqual({ id: 7, done: true });
    expect(refused.status).toBe(400);
    expect(client.lines).toEqual([
      expect.objectContaining({ msg: "request: answered by its route" }),
      expect.objectContaining({
        level: 40,
        msg: "params: refused, rejected by its schema",
      }),
    ]);
  });

  it("sends back a trace ID of the Frontdoor's form, and logs it", async () => {
    const client = createTestClient(domain);

    const response = await client.fetch(
      new Request("https://domain.example/v1/todos/1", {
        headers: { [CORRELATION_ID_HEADER]: TRACE_ID },
      }),
    );

    expect(response.headers.get(CORRELATION_ID_HEADER)).toBe(TRACE_ID);
    expect(client.lines[0]).toMatchObject({ traceId: TRACE_ID });

    const other = await client.fetch(
      new Request("https://domain.example/v1/todos/1", {
        headers: { [CORRELATION_ID_HEADER]: SECRET },
      }),
    );

    expect(other.headers.get(CORRELATION_ID_HEADER)).toBeNull();
    expect(client.lines[1]).not.toHaveProperty("traceId");
  });

  describe("refuses", () => {
    const JSON_HEADERS = { "content-type": "application/json" };

    it.each<[string, Request, number, string]>([
      [
        "an unknown path",
        new Request("https://domain.example/v1/nothing"),
        404,
        "route: none matches the path",
      ],
      [
        "a method the path does not take",
        new Request("https://domain.example/v1/todos", { method: "PUT" }),
        405,
        "route: none for the method on this path",
      ],
      [
        "an invalid query",
        new Request("https://domain.example/v1/todos?done=maybe"),
        400,
        "query: refused, rejected by its schema",
      ],
      [
        "a query on a route without one",
        new Request("https://domain.example/v1/todos/1?done=true"),
        400,
        "query: refused, not declared by the route",
      ],
      [
        "a path parameter that decodes to a slash",
        new Request("https://domain.example/v1/todos/a%2Fb"),
        400,
        "params: refused, does not decode to one segment",
      ],
      [
        "a body on a route without one",
        new Request("https://domain.example/v1/todos/1", {
          method: "DELETE",
          body: "{}",
        }),
        400,
        "body: refused, not declared by the route",
      ],
      [
        "a missing body",
        new Request("https://domain.example/v1/todos", { method: "POST" }),
        400,
        "body: refused, missing",
      ],
      [
        "a body without a content type",
        new Request("https://domain.example/v1/todos", {
          method: "POST",
          body: new Blob([JSON.stringify({ title: "Renew" })]),
        }),
        415,
        "body: refused, content type is not JSON",
      ],
      [
        "a body that does not parse",
        new Request("https://domain.example/v1/todos", {
          method: "POST",
          headers: JSON_HEADERS,
          body: "{",
        }),
        400,
        "body: refused, malformed JSON",
      ],
      [
        "a body nested too deeply",
        new Request("https://domain.example/v1/todos", {
          method: "POST",
          headers: JSON_HEADERS,
          body: `${"[".repeat(65)}${"]".repeat(65)}`,
        }),
        400,
        "body: refused, nested too deeply",
      ],
      [
        "a body holding a __proto__ key",
        new Request("https://domain.example/v1/todos", {
          method: "POST",
          headers: JSON_HEADERS,
          body: `{"title":"Renew","__proto__":{"secret":"${SECRET}"}}`,
        }),
        400,
        "body: refused, holds a __proto__ key",
      ],
      [
        "a body its schema refuses",
        new Request("https://domain.example/v1/todos", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ title: "Renew", secret: SECRET }),
        }),
        400,
        "body: refused, rejected by its schema",
      ],
    ])(
      "%s, in the platform's body, and logs it at warn",
      async (_case, request, status, msg) => {
        const client = createTestClient(domain);

        const response = await client.fetch(request);

        expect(response.status).toBe(status);
        expect(response.headers.get("x-rejected-by")).toBe("domain");
        expect(response.headers.get("content-type")).toBe("application/json");
        expect(await response.json()).toEqual({
          message: expect.any(String) as string,
          type: "client_error",
        });
        expect(client.lines).toEqual([
          expect.objectContaining({ level: 40, status, msg }),
        ]);
        expectNotLogged(client.lines, SECRET);
      },
    );

    it("lists the path's methods in Allow", async () => {
      const client = createTestClient(domain);

      const response = await client.put("/v1/todos/1");

      expect(response.headers.get("allow")).toBe("GET, PATCH, DELETE");
    });

    it("accepts an empty body on a route without one", async () => {
      const client = createTestClient(domain);

      const response = await client.fetch(
        new Request("https://domain.example/v1/todos/1", {
          method: "DELETE",
          headers: JSON_HEADERS,
          body: "",
        }),
      );

      expect(response.status).toBe(204);
    });

    it.each([
      ["no caller token", ""],
      ["an unreadable caller token", "not-a-token"],
    ])("a request with %s, on every path, as a 500", async (_case, token) => {
      const client = createTestClient(domain);

      for (const path of ["/v1/todos/1", "/v1/nothing"]) {
        // The client adds a token unless the request has one, so an empty one stands for none.
        const response = await client.fetch(
          new Request(`https://domain.example${path}`, {
            headers: { [CALLER_TOKEN_HEADER]: token },
          }),
        );

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          message: "Internal server error",
          type: "server_error",
        });
      }

      const line: unknown = expect.objectContaining({
        level: 40,
        status: 500,
        msg: "caller: failed to read caller token",
      });

      expect(client.lines).toEqual([line, line]);
      expect(client.lines[0]).not.toHaveProperty("route");
    });
  });

  describe("a handler's answer", () => {
    it("of a server error is sent in the platform's body, as the handler's, and logged at warn", async () => {
      const client = createTestClient(
        domainWithHandler(() => ({ status: 503 }), { 200: TodoSchema }),
      );

      const response = await client.get("/v1/test");

      expect(response.status).toBe(503);
      expect(response.headers.get("x-rejected-by")).toBeNull();
      expect(await response.json()).toEqual({
        message: "Service unavailable",
        type: "server_error",
      });
      expect(client.lines).toEqual([
        expect.objectContaining({
          level: 40,
          status: 503,
          msg: "handler: returned a server error",
        }),
      ]);
    });

    it.each<[string, () => unknown, RouteConfig["responses"], string]>([
      [
        "a server error with a body",
        () => ({ status: 503, body: { message: SECRET } }),
        { 200: TodoSchema },
        "body: not allowed, status 503 is a server error",
      ],
      [
        "a body its schema refuses",
        () => ({ status: 200, body: { ...TODO, id: 1, title: SECRET } }),
        { 200: TodoSchema },
        "body: invalid, must match the schema for status 200",
      ],
      [
        "a body for a status without one",
        () => ({ status: 204, body: { note: SECRET } }),
        { 204: null },
        "body: not allowed, status 204 has no body",
      ],
    ])(
      "of %s is a 500, logged at error with the problem and nothing of what it held",
      async (_case, handler, responses, problem) => {
        const client = createTestClient(domainWithHandler(handler, responses));

        const response = await client.get("/v1/test");

        expect(response.status).toBe(500);
        expect(response.headers.get("x-rejected-by")).toBe("domain");
        expect(client.lines).toEqual([
          expect.objectContaining({
            level: 50,
            status: 500,
            msg: "handler: returned a result its route does not allow",
            problem,
          }),
        ]);
        expectNotLogged(client.lines, SECRET);
      },
    );

    it("that throws is a 500, logged at error by where it was thrown and not by what it said", async () => {
      const client = createTestClient(
        domainWithHandler(
          () => {
            throw new Error(SECRET);
          },
          { 204: null },
        ),
      );

      const response = await client.get("/v1/test");

      expect(response.status).toBe(500);
      expect(client.lines).toEqual([
        expect.objectContaining({
          level: 50,
          status: 500,
          msg: "handler: threw an unexpected error",
          frames: expect.arrayContaining([
            expect.stringContaining("app.test.ts"),
          ]) as string[],
        }),
      ]);
      expectNotLogged(client.lines, SECRET);
    });

    it.each<[InvocationFailure, number]>([
      ["timed_out", 504],
      ["function_error", 502],
      ["invalid_response", 502],
      ["invoke_failed", 500],
      ["aborted", 500],
    ])(
      "that lets a gateway's %s through is a %i, logged at warn with the reason",
      async (reason, status) => {
        const client = createTestClient(
          domainWithHandler(
            () => {
              throw new GatewayInvocationError(
                reason,
                "The gateway did not answer",
              );
            },
            { 204: null },
          ),
        );

        const response = await client.get("/v1/test");

        expect(response.status).toBe(status);
        expect(response.headers.get("x-rejected-by")).toBe("domain");
        expect(client.lines).toEqual([
          expect.objectContaining({
            level: 40,
            status,
            msg: "gateway: call failed, uncaught by the handler",
            reason,
          }),
        ]);
      },
    );

    it("past the deadline is a 504, with the handler's signal aborted", async () => {
      const handler = vi.fn(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              resolve({ status: 204 });
            });
          }),
      );

      const client = createTestClient(
        domainWithHandler(handler, { 204: null }),
        {
          remainingTimeMs: 550,
        },
      );

      const response = await client.get("/v1/test");

      const [[context] = []] = handler.mock.calls;

      expect(response.status).toBe(504);
      expect(context?.signal.aborted).toBe(true);
      expect(client.lines).toEqual([
        expect.objectContaining({
          level: 40,
          status: 504,
          msg: "handler: passed the request's deadline",
        }),
      ]);
    });
  });

  it("counts the time spent reading the request against the deadline", async () => {
    const handler = vi.fn(async () => {
      await setTimeout(100);

      return { status: 204 };
    });

    // 200ms to answer in: the body's schema takes 150 of them, so a handler that takes 100 more
    // is past the deadline, though it took less than 200 itself.
    const client = createTestClient(
      domainWithHandler(
        handler,
        { 204: null },
        {
          key: "POST /v1/test",
          body: z.strictObject({
            title: z.string().refine(async () => {
              await setTimeout(150);

              return true;
            }),
          }),
        },
      ),
      { remainingTimeMs: 700 },
    );

    const response = await client.post("/v1/test", { title: "Renew" });

    expect(handler).toHaveBeenCalledOnce();
    expect(response.status).toBe(504);
  });

  describe("past the deadline before the handler", () => {
    function expectNeverCalled(
      response: Response,
      handler: () => unknown,
      lines: readonly LogLine[],
    ): void {
      expect(response.status).toBe(504);
      expect(handler).not.toHaveBeenCalled();
      expect(lines).toEqual([
        expect.objectContaining({
          level: 40,
          status: 504,
          msg: "request: passed its deadline before its handler ran",
        }),
      ]);
    }

    it("while the input is read is a 504, and the handler is never called", async () => {
      const handler = vi.fn(() => ({ status: 204 }));

      // 200ms to answer in, and the body's schema takes 300 of them.
      const client = createTestClient(
        domainWithHandler(
          handler,
          { 204: null },
          {
            key: "POST /v1/test",
            body: z.strictObject({
              title: z.string().refine(async () => {
                await setTimeout(300);

                return true;
              }),
            }),
          },
        ),
        { remainingTimeMs: 700 },
      );

      const response = await client.post("/v1/test", { title: "Renew" });

      expectNeverCalled(response, handler, client.lines);
    });

    it("once the input is read is a 504, and the handler is never called", async () => {
      const handler = vi.fn(() => ({ status: 204 }));

      // No time to answer in, though the input is read at once.
      const client = createTestClient(
        domainWithHandler(handler, { 204: null }),
        { remainingTimeMs: 500 },
      );

      const response = await client.get("/v1/test");

      expectNeverCalled(response, handler, client.lines);
    });
  });

  it("is a 504 when the response's schema passes the deadline", async () => {
    const client = createTestClient(
      domainWithHandler(() => ({ status: 200, body: { id: "1" } }), {
        200: z.object({ id: z.string() }).refine(async () => {
          await setTimeout(300);

          return true;
        }),
      }),
      { remainingTimeMs: 700 },
    );

    const response = await client.get("/v1/test");

    expect(response.status).toBe(504);
    expect(client.lines).toEqual([
      expect.objectContaining({
        level: 40,
        status: 504,
        msg: "response: passed the request's deadline",
      }),
    ]);
  });

  describe("a schema", () => {
    // A refinement rather than a transform, which a path or query field may not have.
    const throwing = z.string().refine(() => {
      throw new Error(SECRET);
    });

    it.each<[string, Partial<RouteConfig> & { key: string }, Request]>([
      [
        "query",
        { key: "GET /v1/test", query: z.strictObject({ tag: throwing }) },
        new Request("https://domain.example/v1/test?tag=a"),
      ],
      [
        "params",
        { key: "GET /v1/test/{id}", params: z.object({ id: throwing }) },
        new Request("https://domain.example/v1/test/a"),
      ],
      [
        "body",
        { key: "POST /v1/test", body: z.strictObject({ title: throwing }) },
        new Request("https://domain.example/v1/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Renew" }),
        }),
      ],
    ])(
      "for %s that throws is a 500, logged at error as its own failure, and no handler runs",
      async (part, route, request) => {
        const handler = vi.fn(() => ({ status: 204 }));

        const client = createTestClient(
          domainWithHandler(handler, { 204: null }, route),
        );

        const response = await client.fetch(request);

        expect(handler).not.toHaveBeenCalled();
        expect(response.status).toBe(500);
        expect(response.headers.get("x-rejected-by")).toBe("domain");
        expect(client.lines).toEqual([
          expect.objectContaining({
            level: 50,
            status: 500,
            msg: `${part}: failed, its schema threw`,
            route: route.key,
            frames: expect.arrayContaining([
              expect.stringContaining("app.test.ts"),
            ]) as string[],
          }),
        ]);
        expectNotLogged(client.lines, SECRET);
      },
    );

    it("for a response that throws is a 500, logged at error as its own failure, not the handler's", async () => {
      const client = createTestClient(
        domainWithHandler(() => ({ status: 200, body: { id: "1" } }), {
          200: z.object({ id: throwing }),
        }),
      );

      const response = await client.get("/v1/test");

      expect(response.status).toBe(500);
      expect(client.lines).toEqual([
        expect.objectContaining({
          level: 50,
          status: 500,
          msg: "response: failed, its schema threw",
          route: TEST_ROUTE,
        }),
      ]);
      expectNotLogged(client.lines, SECRET);
    });

    it("for a body finds a field only where the request set it, never one every object inherits", async () => {
      const clientFor = (body: z.ZodType) =>
        createTestClient(
          domainWithHandler(
            () => ({ status: 204 }),
            { 204: null },
            { key: "POST /v1/test", body },
          ),
        );

      const required = clientFor(z.strictObject({ toString: z.unknown() }));

      const optional = clientFor(
        z.strictObject({ toString: z.string().optional() }),
      );

      expect((await required.post("/v1/test", {})).status).toBe(400);
      expect((await optional.post("/v1/test", {})).status).toBe(204);
    });

    it("with async refinements checks each part and the response", async () => {
      const nonEmpty = z
        .string()
        .refine((value) => Promise.resolve(value !== ""));

      const client = createTestClient(
        domainWithHandler(
          ({ params, query, body }: Record<string, { value: string }>) => ({
            status: 200,
            body: { value: `${params?.value}${query?.value}${body?.value}` },
          }),
          { 200: z.object({ value: nonEmpty }) },
          {
            key: "POST /v1/test/{value}",
            params: z.object({ value: nonEmpty }),
            query: z.strictObject({ value: nonEmpty }),
            body: z.strictObject({ value: nonEmpty }),
          },
        ),
      );

      const answered = await client.post("/v1/test/a?value=b", { value: "c" });

      const refused = await client.post("/v1/test/a?value=b", { value: "" });

      expect(answered.status).toBe(200);
      expect(await answered.json()).toEqual({ value: "abc" });
      expect(refused.status).toBe(400);
      expect(client.lines).toEqual([
        expect.objectContaining({ msg: "request: answered by its route" }),
        expect.objectContaining({
          msg: "body: refused, rejected by its schema",
        }),
      ]);
    });
  });

  describe("logging", () => {
    it("writes a handler's own lines with the request's trace ID and route, and the caller's IDs redacted", async () => {
      const client = createTestClient(
        domainWithHandler(
          ({ log, caller }: { log: Logger; caller: object }) => {
            log.error({ todo: TODO, caller }, "handler line");

            return { status: 204 };
          },
          { 204: null },
        ),
      );

      await client.fetch(
        new Request("https://domain.example/v1/test", {
          headers: { [CORRELATION_ID_HEADER]: TRACE_ID },
        }),
      );

      expect(client.lines).toEqual([
        expect.objectContaining({
          level: 50,
          msg: "handler line",
          traceId: TRACE_ID,
          route: TEST_ROUTE,
          todo: TODO,
          caller: { pairwiseId: REDACTED, pushId: REDACTED },
        }),
        expect.objectContaining({
          msg: "request: answered by its route",
          status: 204,
        }),
      ]);
    });
  });

  describe("a failure of the SDK itself", () => {
    function captured() {
      const lines: unknown[] = [];

      const logger = createLogger("domain-a", {
        write: (line: string) => {
          const parsed: unknown = JSON.parse(line);

          lines.push(parsed);
        },
      });

      return { lines, logger };
    }

    function signedRequest(path: string): Request {
      return new Request(`https://domain.example${path}`, {
        headers: {
          [CALLER_TOKEN_HEADER]: unsignedCallerToken({
            pairwiseId: "test-user",
            pushId: "test-push-id",
          }),
        },
      });
    }

    it("once a route is found is a 500, logged at error with its route", async () => {
      const { lines, logger } = captured();

      vi.spyOn(logger, "child").mockImplementation(() => {
        throw new Error(SECRET);
      });

      const app = createApp(domain, { logger });

      const response = await app.fetch(signedRequest("/v1/todos/1"), {
        remainingTimeMs: 10_000,
      });

      expect(response.status).toBe(500);
      expect(lines).toEqual([
        expect.objectContaining({
          level: 50,
          status: 500,
          msg: "sdk: failed while answering the request",
          route: "GET /v1/todos/{id}",
        }),
      ]);
      expect(JSON.stringify(lines)).not.toContain(SECRET);
    });

    it("before a route is found is a 500, logged at error without one", async () => {
      const { lines, logger } = captured();

      const request = signedRequest("/v1/todos/1");

      const { headers } = request;

      const get = headers.get.bind(headers);

      vi.spyOn(headers, "get").mockImplementation((name) => {
        if (name === CALLER_TOKEN_HEADER) throw new Error(SECRET);

        return get(name);
      });

      const app = createApp(domain, { logger });

      const response = await app.fetch(request, { remainingTimeMs: 10_000 });

      expect(response.status).toBe(500);
      expect(lines).toEqual([
        expect.objectContaining({
          level: 50,
          msg: "sdk: failed while answering the request",
        }),
      ]);
      expect(lines[0]).not.toHaveProperty("route");
    });
  });
});
