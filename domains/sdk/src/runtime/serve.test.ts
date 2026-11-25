import type { InvocationFailure } from "@govuk-once/flex-gateway-client";
import { GatewayInvocationError } from "@govuk-once/flex-gateway-client";
import * as callerModule from "@govuk-once/flex-gateway-client/caller";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createTestClient,
  testCallerToken,
} from "../../test/fixtures/test-client.ts";
import { DomainConfigError } from "../check-domain.ts";
import { CALLER_TOKEN_HEADER, CORRELATION_ID_HEADER } from "../http.ts";
import type { Log } from "../log.ts";
import type { DomainConfig } from "../types.ts";

type CallerModule = typeof callerModule;

vi.mock("@govuk-once/flex-gateway-client/caller", async (importOriginal) => {
  const actual = await importOriginal<CallerModule>();

  return { ...actual, withCallerContext: vi.fn(actual.withCallerContext) };
});

const SECRET = "SYNTHETIC_SECRET";

const TRACE_ID = "1-5759e988-bd862e3fe1be46a994272793";

const Todo = z.object({ id: z.string(), title: z.string() });

const IdParams = z.object({ id: z.string() });

interface Seen {
  context?: Record<string, unknown>;
  signal?: AbortSignal;
}

const seen: Seen = {};

const behaviours: Readonly<
  Record<string, (context: { signal: AbortSignal; log: Log }) => unknown>
> = {
  ok: () => ({ status: 200, body: { id: "1", title: "Renew" } }),
  throws: () => {
    throw new Error(SECRET);
  },
  "server-error": () => ({ status: 503 }),
  "server-error-with-body": () => ({ status: 503, body: { message: SECRET } }),
  unauthorized: () => ({ status: 401 }),
  forbidden: () => ({ status: 403 }),
  undeclared: () => ({ status: 418 }),
  "wrong-body": () => ({ status: 200, body: { id: 1 } }),
  "body-for-null": () => ({ status: 204, body: {} }),
  nothing: () => undefined,
  unwritable: () => ({ status: 200, body: { id: "1", title: 1n } }),
  slow: ({ signal }) =>
    new Promise((resolve) => {
      seen.signal = signal;
      signal.addEventListener("abort", () => {
        resolve({ status: 200, body: { id: "1", title: "late" } });
      });
    }),
  logs: ({ log }) => {
    log.info("handler line", { attempt: 1 });

    return { status: 204 };
  },
};

const domain: DomainConfig = {
  name: "domain-a",
  description: "A domain for tests",
  routes: {
    "GET /v1/todos": {
      description: "A route",
      handler: ({ query }: { query: { page?: number } }) => ({
        status: 200,
        body: { items: [{ id: "1", title: SECRET }], page: query.page },
      }),
      query: z.strictObject({
        page: z.number().optional(),
        tag: z.array(z.string()).optional(),
      }),
      responses: {
        200: z.object({ items: z.array(Todo), page: z.number().optional() }),
      },
      log: { input: ["query.page"], output: ["page", "items.*.id"] },
    },
    "GET /v1/todos/archived": {
      description: "A route",
      handler: () => ({ status: 200, body: { items: [] } }),
      responses: { 200: z.object({ items: z.array(Todo) }) },
    },
    "GET /v1/todos/{id}": {
      description: "A route",
      handler: (context: Record<string, unknown>) => {
        seen.context = context;

        return {
          status: 200,
          body: { id: "1", title: "Renew", extra: SECRET },
        };
      },
      params: IdParams,
      responses: { 200: Todo, 404: z.object({ code: z.string() }) },
    },
    "POST /v1/todos": {
      description: "A route",
      handler: ({ body }: { body: { title: string } }) => ({
        status: 201,
        body: { id: "2", title: body.title },
      }),
      body: z.strictObject({ title: z.string() }),
      responses: { 201: Todo },
      log: { input: ["body.title"] },
    },
    "DELETE /v1/todos/{id}": {
      description: "A route",
      handler: () => ({ status: 204 }),
      params: IdParams,
      responses: { 204: null },
    },
    "GET /v1/behaviours/{kind}": {
      description: "A route",
      handler: (context: {
        params: { kind: string };
        signal: AbortSignal;
        log: Log;
      }) => {
        const behaviour = behaviours[context.params.kind];

        if (behaviour !== undefined) return behaviour(context);

        const reason = context.params.kind as InvocationFailure;

        throw new GatewayInvocationError(reason, "The gateway did not answer");
      },
      params: z.object({ kind: z.string() }),
      responses: { 200: Todo, 204: null },
    },
  },
};

function clientWith(options: { remainingTimeMs?: number } = {}) {
  const lines: Record<string, unknown>[] = [];

  const client = createTestClient(domain, {
    ...options,
    onLog: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });

  return { client, lines, text: () => JSON.stringify(lines) };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("serve", () => {
  it("refuses a configuration that never passed through defineDomain, as it loads", () => {
    const unchecked: DomainConfig = {
      name: "Domain_A",
      routes: { "GET /v1/todos": { handler: () => undefined, responses: {} } },
    };

    expect(() => createTestClient(unchecked)).toThrow(DomainConfigError);
  });

  it("answers a route with its handler's body, as its schema writes it, and logs it at info", async () => {
    const { client, lines } = clientWith();

    const response = await client.get("/v1/todos/1");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-rejected-by")).toBeNull();
    expect(await response.json()).toEqual({ id: "1", title: "Renew" });
    expect(lines).toEqual([
      expect.objectContaining({
        level: 30,
        name: "domain-a",
        msg: "request answered",
        route: "GET /v1/todos/{id}",
        status: 200,
        durationMs: expect.any(Number) as number,
      }),
    ]);
  });

  it("answers a null body status with no body", async () => {
    const { client } = clientWith();

    const response = await client.delete("/v1/todos/1");

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-type")).toBeNull();
  });

  it("gives the handler its declared parts, the caller, a signal and a log, and runs it in the caller's context", async () => {
    const { client } = clientWith({ remainingTimeMs: 5_000 });

    const before = Date.now();

    await client.request(
      new Request("https://domain.invalid/v1/todos/1", {
        headers: {
          [CALLER_TOKEN_HEADER]: testCallerToken({
            pairwiseId: "user-a",
            pushId: "push-a",
          }),
        },
      }),
    );

    expect(Object.keys(seen.context ?? {}).sort()).toEqual([
      "caller",
      "log",
      "params",
      "signal",
    ]);
    expect(seen.context).toMatchObject({
      params: { id: "1" },
      caller: { pairwiseId: "user-a", pushId: "push-a" },
    });

    const [call] = vi.mocked(callerModule.withCallerContext).mock.calls;

    assert(call !== undefined);

    const [context] = call;

    expect(context.secure?.token).toBe(
      testCallerToken({ pairwiseId: "user-a", pushId: "push-a" }),
    );
    expect(context.deadline).toBeGreaterThanOrEqual(before + 4_500);
    expect(context.deadline).toBeLessThanOrEqual(Date.now() + 4_500);
  });

  it("reads query and path values by their declared types", async () => {
    const { client } = clientWith();

    const response = await client.get("/v1/todos?page=2");

    expect(await response.json()).toMatchObject({ page: 2 });
  });

  it("prefers a literal segment to a parameter", async () => {
    const { client } = clientWith();

    expect(await (await client.get("/v1/todos/archived")).json()).toEqual({
      items: [],
    });
  });

  it("sends back a trace ID of the Frontdoor's form, and logs it", async () => {
    const { client, lines } = clientWith();

    const response = await client.request(
      new Request("https://domain.invalid/v1/todos/1", {
        headers: { [CORRELATION_ID_HEADER]: TRACE_ID },
      }),
    );

    expect(response.headers.get(CORRELATION_ID_HEADER)).toBe(TRACE_ID);
    expect(lines[0]).toMatchObject({ traceId: TRACE_ID });

    const other = await client.request(
      new Request("https://domain.invalid/v1/todos/1", {
        headers: { [CORRELATION_ID_HEADER]: SECRET },
      }),
    );

    expect(other.headers.get(CORRELATION_ID_HEADER)).toBeNull();
    expect(lines[1]).not.toHaveProperty("traceId");
  });

  describe("refuses", () => {
    it.each<[string, Request, number, Record<string, unknown>]>([
      [
        "an unknown path",
        new Request("https://domain.invalid/v1/nothing"),
        404,
        {},
      ],
      [
        "a method the path does not take",
        new Request("https://domain.invalid/v1/todos", { method: "PUT" }),
        405,
        {},
      ],
      [
        "an invalid query",
        new Request("https://domain.invalid/v1/todos?page=two"),
        400,
        { part: "query" },
      ],
      [
        "an undeclared query parameter",
        new Request("https://domain.invalid/v1/todos?size=2"),
        400,
        { part: "query" },
      ],
      [
        "a query on a route without one",
        new Request("https://domain.invalid/v1/todos/1?page=2"),
        400,
        { part: "query" },
      ],
      [
        "a path parameter that does not decode",
        new Request("https://domain.invalid/v1/todos/%E0%A4%A"),
        400,
        { part: "params" },
      ],
      [
        "a path parameter that decodes to a slash",
        new Request("https://domain.invalid/v1/todos/a%2Fb"),
        400,
        { part: "params" },
      ],
      [
        "a body on a route without one",
        new Request("https://domain.invalid/v1/todos/1", {
          method: "DELETE",
          body: "{}",
        }),
        400,
        { part: "body" },
      ],
      [
        "a missing body",
        new Request("https://domain.invalid/v1/todos", { method: "POST" }),
        400,
        { part: "body" },
      ],
      [
        "a body that is not JSON",
        new Request("https://domain.invalid/v1/todos", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
        400,
        { part: "body" },
      ],
      [
        "a body its schema refuses",
        new Request("https://domain.invalid/v1/todos", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Renew", secret: SECRET }),
        }),
        400,
        { part: "body" },
      ],
      [
        "a body that is not JSON by its type",
        new Request("https://domain.invalid/v1/todos", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: JSON.stringify({ title: "Renew" }),
        }),
        415,
        { part: "body" },
      ],
    ])(
      "%s, in the platform's body, and logs it at warn",
      async (_case, request, status, fields) => {
        const { client, lines, text } = clientWith();

        const response = await client.request(request);

        expect(response.status).toBe(status);
        expect(response.headers.get("x-rejected-by")).toBe("domain");
        expect(response.headers.get("content-type")).toBe("application/json");
        expect(await response.json()).toEqual({
          message: expect.any(String) as string,
          type: "client_error",
        });
        expect(lines).toEqual([
          expect.objectContaining({ level: 40, status, ...fields }),
        ]);
        expect(text()).not.toContain(SECRET);
      },
    );

    it("lists the path's methods in Allow", async () => {
      const { client } = clientWith();

      const response = await client.request(
        new Request("https://domain.invalid/v1/todos/1", { method: "PATCH" }),
      );

      expect(response.headers.get("allow")).toBe("GET, DELETE");
    });

    it("accepts an empty body on a route without one", async () => {
      const { client } = clientWith();

      const response = await client.request(
        new Request("https://domain.invalid/v1/todos/1", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: "",
        }),
      );

      expect(response.status).toBe(204);
    });

    it.each([
      ["no caller token", undefined],
      ["an unreadable caller token", "not-a-token"],
    ])("a request with %s, on every path, as a 500", async (_case, token) => {
      const { client, lines } = clientWith();

      for (const path of ["/v1/todos/1", "/v1/nothing"]) {
        const request = new Request(`https://domain.invalid${path}`);

        // The client adds a token unless the request has one, so an empty one stands for none.
        request.headers.set(CALLER_TOKEN_HEADER, token ?? "");

        const response = await client.request(request);

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          message: "Internal server error",
          type: "server_error",
        });
      }

      expect(lines).toEqual([
        expect.objectContaining({ level: 40, status: 500 }),
        expect.objectContaining({ level: 40, status: 500 }),
      ]);
      expect(lines[0]).not.toHaveProperty("route");
    });
  });

  describe("a handler's answer", () => {
    it("of a server error is sent in the platform's body, as the handler's, and logged at warn", async () => {
      const { client, lines } = clientWith();

      const response = await client.get("/v1/behaviours/server-error");

      expect(response.status).toBe(503);
      expect(response.headers.get("x-rejected-by")).toBeNull();
      expect(await response.json()).toEqual({
        message: "Service unavailable",
        type: "server_error",
      });
      expect(lines).toEqual([
        expect.objectContaining({ level: 40, status: 503 }),
      ]);
    });

    it.each([
      "throws",
      "server-error-with-body",
      "unauthorized",
      "forbidden",
      "undeclared",
      "wrong-body",
      "body-for-null",
      "nothing",
      "unwritable",
    ])(
      "that %s is a 500, logged at error with nothing of what it held",
      async (kind) => {
        const { client, lines, text } = clientWith();

        const response = await client.get(`/v1/behaviours/${kind}`);

        expect(response.status).toBe(500);
        expect(response.headers.get("x-rejected-by")).toBe("domain");
        expect(lines).toEqual([
          expect.objectContaining({ level: 50, status: 500 }),
        ]);
        expect(text()).not.toContain(SECRET);
      },
    );

    it("that throws is logged by where it was thrown", async () => {
      const { client, lines } = clientWith();

      await client.get("/v1/behaviours/throws");

      expect(lines[0]).toMatchObject({
        frames: expect.arrayContaining([
          expect.stringContaining("serve.test.ts"),
        ]) as string[],
      });
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
        const { client, lines } = clientWith();

        const response = await client.get(`/v1/behaviours/${reason}`);

        expect(response.status).toBe(status);
        expect(response.headers.get("x-rejected-by")).toBe("domain");
        expect(lines).toEqual([
          expect.objectContaining({ level: 40, status, reason }),
        ]);
      },
    );

    it("past the deadline is a 504, with the handler's signal aborted", async () => {
      const { client, lines } = clientWith({ remainingTimeMs: 550 });

      const response = await client.get("/v1/behaviours/slow");

      expect(response.status).toBe(504);
      expect(seen.signal?.aborted).toBe(true);
      expect(lines).toEqual([
        expect.objectContaining({ level: 40, status: 504 }),
      ]);
    });
  });

  describe("logging", () => {
    it("picks what the route's log names from its input and output, and nothing else", async () => {
      const { client, lines, text } = clientWith();

      await client.get("/v1/todos?page=3&tag=a");

      expect(lines).toEqual([
        expect.objectContaining({
          input: { "query.page": 3 },
          output: { page: 3, "items.*.id": ["1"] },
        }),
      ]);
      expect(text()).not.toContain(SECRET);
    });

    it("writes a handler's own lines with the request's trace ID and route", async () => {
      const { client, lines } = clientWith();

      await client.request(
        new Request("https://domain.invalid/v1/behaviours/logs", {
          headers: { [CORRELATION_ID_HEADER]: TRACE_ID },
        }),
      );

      expect(lines).toEqual([
        expect.objectContaining({
          level: 30,
          msg: "handler line",
          traceId: TRACE_ID,
          route: "GET /v1/behaviours/{kind}",
          fields: { attempt: 1 },
        }),
        expect.objectContaining({ msg: "request answered", status: 204 }),
      ]);
    });

    it("replaces the caller's IDs wherever a picked value holds one", async () => {
      const { client, lines } = clientWith();

      await client.post("/v1/todos", { title: "for test-user" });

      expect(lines).toEqual([
        expect.objectContaining({
          level: 40,
          input: { "body.title": "[caller value]" },
          replaced: ["input.body.title"],
        }),
      ]);
    });
  });
});
