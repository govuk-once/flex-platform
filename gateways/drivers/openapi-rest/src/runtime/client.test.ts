import { GatewayError } from "@repo/gateway-runtime";
import { describe, expect, it, vi } from "vitest";

import {
  fakeFetch,
  headerOf,
  json,
  passthroughContext,
} from "../../test/helpers.ts";
import { buildUrl, createClient } from "./client.ts";
import {
  compileOperation,
  type OpenApiRestOperationConfig,
} from "./operation.ts";

const TARGET = new URL("https://api.test/prod");
const GET_USER: OpenApiRestOperationConfig = {
  upstream: "GET /users/{id}",
  parameters: { id: { in: "path" } },
};

function client(
  respond: Parameters<typeof fakeFetch>[0],
  overrides: Partial<Parameters<typeof createClient>[2]> = {},
  config: OpenApiRestOperationConfig = GET_USER,
) {
  const ff = fakeFetch(respond);
  const ctx = passthroughContext();
  const op = compileOperation("getUser", config);
  const c = createClient(ctx, op, {
    target: TARGET,
    fetch: ff.fetch,
    staticHeaders: new Headers(),
    auth: () => Promise.resolve(new Headers()),
    reservedHeaders: new Set(),
    maxResponseBytes: 1_048_576,
    metadata: [],
    ...overrides,
  });
  return { c, ff, ctx };
}

describe("buildUrl", () => {
  it("appends the path to the target path prefix", () => {
    expect(buildUrl(TARGET, "/users/1", undefined).href).toBe(
      "https://api.test/prod/users/1",
    );
  });

  it("handles a trailing slash on the target", () => {
    expect(
      buildUrl(new URL("https://api.test/prod/"), "/users", undefined).href,
    ).toBe("https://api.test/prod/users");
  });

  it("serialises query values with URLSearchParams and repeats arrays", () => {
    expect(
      buildUrl(TARGET, "/users", { q: "a b&c", ids: [1, 2], ok: true }).search,
    ).toBe("?q=a+b%26c&ids=1&ids=2&ok=true");
  });

  it("writes nothing at all for an array with nothing in it", () => {
    // The name is written once per element, so an empty array leaves the parameter out of the
    // request entirely. Deriving refuses a required parameter that admits one, since a
    // validator admitting the value would let the call through to this.
    const url = buildUrl(TARGET, "/users", { ids: [], q: "a" });
    expect(url.search).toBe("?q=a");
    expect(url.href).toBe("https://api.test/prod/users?q=a");
  });

  it("preserves percent-encoded path characters", () => {
    expect(buildUrl(TARGET, "/files/a%2Fb%3Fc", undefined).pathname).toBe(
      "/prod/files/a%2Fb%3Fc",
    );
  });

  it("rejects a path without a leading slash", () => {
    expect(() => buildUrl(TARGET, "users", undefined)).toThrow(
      /must start with "\/"/,
    );
  });

  // The parser strips these before anything else, so it would otherwise rewrite the path, or
  // read a dot segment the written path never showed.
  it.each(["/users/x\ty", "/users/.\t./admin", "/users/%2\te%2e/admin"])(
    "rejects the control character in %j",
    (path) => {
      expect(() => buildUrl(TARGET, path, undefined)).toThrow(
        /must not contain a control character/,
      );
    },
  );

  // The parser would resolve these away silently, leaving the target's path prefix behind.
  it.each(["/users/../../admin", "/users/%2e%2e/admin", "/a/./b"])(
    "rejects the dot segment in %j",
    (path) => {
      expect(() => buildUrl(TARGET, path, undefined)).toThrow(
        /must not contain a dot segment/,
      );
    },
  );
});

describe("template composition", () => {
  it("interpolates a parameter into a suffixed segment", () => {
    const op = compileOperation("get", {
      upstream: "GET /users/{id}.json",
      parameters: { id: { in: "path" } },
    });
    const { path } = op.prepare({ id: "u1" });
    expect(path).toBe("/users/u1.json");
    expect(buildUrl(TARGET, path, undefined).href).toBe(
      "https://api.test/prod/users/u1.json",
    );
  });

  // The value that completed the escape in the reported case. With the template refused at
  // compilation, a value that merely resembles half of one stays in its own segment.
  it("keeps an escape-shaped value inside its segment", () => {
    const op = compileOperation("get", {
      upstream: "GET /users/{id}/tail",
      parameters: { id: { in: "path" } },
    });
    const { path } = op.prepare({ id: "2e" });
    expect(buildUrl(TARGET, path, undefined).href).toBe(
      "https://api.test/prod/users/2e/tail",
    );
  });

  it("refuses a template whose escape a parameter would complete", () => {
    expect(() =>
      compileOperation("get", {
        upstream: "GET /users/%2e%{id}/tail",
        parameters: { id: { in: "path" } },
      }),
    ).toThrow(/incomplete percent escape/);
  });

  it.each(["GET /../admin", "GET /%2e%2e/admin"] as const)(
    "refuses the literal traversal %j",
    (upstream) => {
      expect(() => compileOperation("get", { upstream })).toThrow(
        /dot segment/,
      );
    },
  );
});

describe("client.request", () => {
  it("sends the method, URL, accept header and abort signal", async () => {
    const { c, ff } = client(() => json(200, {}));
    await c.request({ method: "GET", path: "/users/1", query: { v: 2 } });

    expect(ff.calls).toHaveLength(1);
    const [req] = ff.calls;
    expect(req?.url).toBe("https://api.test/prod/users/1?v=2");
    expect(req?.init.method).toBe("GET");
    expect(req?.init.redirect).toBe("manual");
    expect(req?.init.signal).toBeInstanceOf(AbortSignal);
    expect(headerOf(req!, "accept")).toBe("application/json");
    expect(headerOf(req!, "content-type")).toBeNull();
    expect(req?.init.body).toBeUndefined();
  });

  it("serialises the body as JSON and sets content-type", async () => {
    const { c, ff } = client(
      () => json(201, {}),
      {},
      { upstream: "POST /users" },
    );
    await c.request({ method: "POST", path: "/users", body: { a: 1 } });
    const [req] = ff.calls;
    expect(req?.init.body).toBe('{"a":1}');
    expect(headerOf(req!, "content-type")).toBe("application/json");
  });

  it("layers static, call and authentication headers in that order", async () => {
    const auth = vi.fn(() =>
      Promise.resolve(new Headers({ "x-b": "auth", "x-c": "auth" })),
    );
    const { c, ff } = client(() => json(200, {}), {
      staticHeaders: new Headers({ "x-a": "static", "x-b": "static" }),
      auth,
    });
    await c.request({
      method: "GET",
      path: "/users/1",
      headers: { "X-B": "call", "X-D": "call" },
    });
    const [req] = ff.calls;
    expect(headerOf(req!, "x-a")).toBe("static");
    expect(headerOf(req!, "x-b")).toBe("auth");
    expect(headerOf(req!, "x-c")).toBe("auth");
    expect(headerOf(req!, "x-d")).toBe("call");
    expect(auth).toHaveBeenCalledWith("getUser", expect.any(AbortSignal));
  });

  it("runs authentication inside the timed attempt", async () => {
    const order: string[] = [];
    const ff = fakeFetch(() => {
      order.push("fetch");
      return json(200, {});
    });
    const ctx = {
      upstream<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
        order.push("attempt-start");
        return fn(new AbortController().signal).finally(() => {
          order.push("attempt-end");
        });
      },
      meta: () => undefined,
    };
    const op = compileOperation("getUser", GET_USER);
    const c = createClient(ctx, op, {
      target: TARGET,
      fetch: ff.fetch,
      staticHeaders: new Headers(),
      reservedHeaders: new Set(),
      auth: () => {
        order.push("auth");
        return Promise.resolve(new Headers({ authorization: "Bearer t" }));
      },
      maxResponseBytes: 1_048_576,
      metadata: [],
    });
    await c.request({ method: "GET", path: "/users/1" });
    expect(order).toEqual(["attempt-start", "auth", "fetch", "attempt-end"]);
  });

  it("names the header but not the value when a value is invalid", async () => {
    const { c } = client(() => json(200, {}));
    const err = await c
      .request({
        method: "GET",
        path: "/users/1",
        headers: { "x-token": "SYNTHETIC_SECRET_123\ninvalid" },
      })
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("INTERNAL");
    expect((err as Error).message).toBe(
      'Operation "getUser" call headers: header "x-token" has an invalid value',
    );
    expect((err as Error).cause).toBeUndefined();
  });

  it("replaces JSON serialisation errors with a controlled message", async () => {
    const { c } = client(() => json(200, {}), {}, { upstream: "POST /users" });
    await expect(
      c.request({ method: "POST", path: "/users", body: { n: 10n } }),
    ).rejects.toThrow(
      'Request body cannot be serialised as JSON for operation "getUser"',
    );
  });

  it("stops reading and cancels a body past maxResponseBytes", async () => {
    let cancelled = false;
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { c } = client(() => new Response(endless, { status: 500 }), {
      maxResponseBytes: 4096,
    });
    await expect(
      c.request({ method: "GET", path: "/users/1" }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_CONTRACT_VIOLATION",
      message:
        'Upstream response exceeded 4096 bytes for operation "getUser" (GET /users/{id})',
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });

  it("rejects a declared content-length past the limit before reading", async () => {
    let pulled = false;
    // highWaterMark 0 so the stream does not pull until something reads it.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new Uint8Array(8));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const { c } = client(
      () =>
        new Response(body, {
          status: 200,
          headers: { "content-length": "999999" },
        }),
      { maxResponseBytes: 4096 },
    );
    await expect(
      c.request({ method: "GET", path: "/users/1" }),
    ).rejects.toMatchObject({ code: "UPSTREAM_CONTRACT_VIOLATION" });
    expect(pulled).toBe(false);
  });

  it("reads a body within the limit", async () => {
    const { c } = client(() => json(200, { ok: true }), {
      maxResponseBytes: 64,
    });
    const res = await c.request({ method: "GET", path: "/users/1" });
    expect(res.json()).toEqual({ ok: true });
  });

  it("rejects reserved headers from the call", async () => {
    const { c: fromCall } = client(() => json(200, {}));
    await expect(
      fromCall.request({
        method: "GET",
        path: "/users/1",
        headers: { "content-length": "1" },
      }),
    ).rejects.toThrow(/call headers: header "content-length"/);
  });

  it("rejects a call header the authentication owns", async () => {
    const { c, ff } = client(() => json(200, {}), {
      staticHeaders: new Headers({ authorization: "Bearer deployment" }),
      reservedHeaders: new Set(["authorization"]),
    });
    await expect(
      c.request({
        method: "GET",
        path: "/users/1",
        headers: { Authorization: "Bearer SYNTHETIC" },
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL",
      message:
        'Operation "getUser": call header "authorization" is reserved by the driver\'s authentication and cannot be set',
    });
    expect(ff.calls).toHaveLength(0);
  });

  it("makes exactly one upstream attempt per request", async () => {
    const { c, ctx } = client(() => json(200, {}));
    await c.request({ method: "GET", path: "/users/1" });
    await c.request({ method: "GET", path: "/users/2" });
    expect(ctx.attempts).toBe(2);
  });

  // A write the upstream refused must not be sent again: a failure is where a retry would be
  // added, inside the attempt where the context would never see it. Counting the requests as
  // well as the attempts is what shows neither happened.
  const failures: [string, Parameters<typeof fakeFetch>[0]][] = [
    ["an error response", () => json(500, { message: "boom" })],
    ["a refusal of the gateway's own credentials", () => json(401, {})],
    [
      "a transport failure",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ];

  it.each(failures)("sends a failing POST once, on %s", async (_l, respond) => {
    const { c, ff, ctx } = client(respond, {}, { upstream: "POST /users" });

    await expect(
      c.invoke({ method: "POST", path: "/users", body: { a: 1 } }),
    ).rejects.toBeInstanceOf(GatewayError);

    expect(ff.calls).toHaveLength(1);
    expect(ctx.attempts).toBe(1);
  });

  it("returns raw status, headers and body for non-2xx responses", async () => {
    const { c } = client(
      () => new Response("nope", { status: 418, headers: { "x-r": "1" } }),
    );
    const res = await c.request({ method: "GET", path: "/users/1" });
    expect(res.status).toBe(418);
    expect(res.headers.get("x-r")).toBe("1");
    expect(res.text).toBe("nope");
    expect(() => res.json()).toThrow(
      expect.objectContaining({ code: "UPSTREAM_CONTRACT_VIOLATION" }),
    );
  });

  it("maps transport failures to UPSTREAM_ERROR with a controlled message", async () => {
    const { c } = client(() => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
          code: "ECONNREFUSED",
        }),
      });
    });
    const err = await c
      .request({ method: "GET", path: "/users/1" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("UPSTREAM_ERROR");
    expect((err as GatewayError).message).toBe(
      'Upstream request failed for operation "getUser" (GET /users/{id}): TypeError (ECONNREFUSED)',
    );
  });

  it("throws a controlled error when the attempt was aborted", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    const ff = fakeFetch((req) => {
      (req.init.signal as AbortSignal).throwIfAborted();
      throw abortError;
    });
    const ctx = {
      upstream<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const controller = new AbortController();
        controller.abort();
        return fn(controller.signal);
      },
      meta: () => undefined,
    };
    const op = compileOperation("getUser", GET_USER);
    const c = createClient(ctx, op, {
      target: TARGET,
      fetch: ff.fetch,
      staticHeaders: new Headers(),
      auth: () => Promise.resolve(new Headers()),
      reservedHeaders: new Set(),
      maxResponseBytes: 1_048_576,
      metadata: [],
    });
    const err = await c
      .request({ method: "GET", path: "/users/1" })
      .catch((e: unknown) => e as Error);
    expect(err).not.toBe(abortError);
    expect((err as Error).message).toBe(
      'Upstream attempt aborted for operation "getUser" (GET /users/{id})',
    );
    expect((err as Error).cause).toBeUndefined();
  });

  it("rejects a GET with a body and an unsupported method", async () => {
    const { c } = client(() => json(200, {}));
    await expect(
      c.request({ method: "GET", path: "/x", body: {} }),
    ).rejects.toThrow(/GET requests cannot carry a body/);
    await expect(
      c.request({ method: "TRACE" as "GET", path: "/x" }),
    ).rejects.toThrow(/unsupported method "TRACE"/);
  });
});

describe("the request boundary", () => {
  // A handler composes its own path, so no parameter encoding has run on it. This is what
  // stops input interpolated straight into one from reaching the upstream as another address.
  it.each([
    "/users/../../admin",
    "/users/%2E%2E/admin",
    "/users/./1",
    "/users\\..\\admin",
    "/users/.\t./.\n./admin",
    "/users/%2\te%2e/admin",
  ])("makes no request when a handler's path %j is refused", async (path) => {
    const { c, ff } = client(() => json(200, {}));
    await expect(c.request({ method: "GET", path })).rejects.toThrow(
      GatewayError,
    );
    expect(ff.calls).toHaveLength(0);
  });
});

describe("client.invoke", () => {
  it("returns the outcome and parsed data", async () => {
    const { c } = client(() => json(200, { id: "1" }));
    await expect(
      c.invoke({ method: "GET", path: "/users/1" }),
    ).resolves.toEqual({ outcome: "ok", data: { id: "1" } });
  });

  it("returns null data for no_content", async () => {
    const { c } = client(() => new Response(null, { status: 204 }));
    await expect(
      c.invoke({ method: "GET", path: "/users/1" }),
    ).resolves.toEqual({ outcome: "no_content", data: null });
  });

  it("throws the mapped GatewayError for error statuses", async () => {
    const { c } = client(() => json(404, { message: "gone" }));
    await expect(
      c.invoke({ method: "GET", path: "/users/1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws a contract violation for a non-JSON success body", async () => {
    const { c } = client(() => new Response("<html>", { status: 200 }));
    await expect(
      c.invoke({ method: "GET", path: "/users/1" }),
    ).rejects.toMatchObject({ code: "UPSTREAM_CONTRACT_VIOLATION" });
  });

  it("mapResponse maps a response already received without a second request", async () => {
    const { c, ff } = client(() => json(201, { id: "n" }));
    const response = await c.request({ method: "GET", path: "/users/1" });
    expect(c.mapResponse(response)).toEqual({
      outcome: "created",
      data: { id: "n" },
    });
    expect(() => c.mapResponse({ ...response, status: 503 })).toThrow(
      expect.objectContaining({ code: "UPSTREAM_ERROR" }),
    );
    expect(ff.calls).toHaveLength(1);
  });

  it("prepare delegates to the operation mapping", () => {
    const { c } = client(() => json(200, {}));
    expect(c.prepare({ id: "u 1" })).toEqual({
      method: "GET",
      path: "/users/u%201",
    });
  });
});

describe("what the gateway reports beside a result", () => {
  const metadata = [
    { name: "upstreamRequestId", header: "x-request-id", type: "string" },
    { name: "remaining", header: "x-ratelimit-remaining", type: "integer" },
    { name: "cached", header: "x-cached", type: "boolean" },
  ] as const;
  const answering = (status: number, headers: Record<string, string>) =>
    client(
      () => new Response(status === 204 ? null : "{}", { status, headers }),
      {
        metadata,
      },
    );

  it("reports each header the response carries, under the gateway's name for it and as its type", async () => {
    const { c, ctx } = answering(200, {
      "X-Request-Id": "req-1",
      "X-RateLimit-Remaining": "41",
      "X-Cached": "true",
      "X-Undeclared": "never reported",
    });

    await c.request(c.prepare({ id: "u1" }));

    expect([...ctx.reported]).toEqual([
      ["upstreamRequestId", "req-1"],
      ["remaining", 41],
      ["cached", true],
    ]);
  });

  it("reports nothing for a header the response does not carry", async () => {
    const { c, ctx } = answering(200, { "x-request-id": "req-1" });

    await c.request(c.prepare({ id: "u1" }));

    expect([...ctx.reported]).toEqual([["upstreamRequestId", "req-1"]]);
  });

  it("leaves text that is not its type as text, for the gateway's validator to refuse", async () => {
    const { c, ctx } = answering(200, {
      "x-ratelimit-remaining": "plenty",
      "x-cached": "yes",
    });

    await c.request(c.prepare({ id: "u1" }));

    expect([...ctx.reported]).toEqual([
      ["remaining", "plenty"],
      ["cached", "yes"],
    ]);
  });

  it("reports before the status is read as an error, so a refusal carries it too", async () => {
    const { c, ctx } = answering(500, { "x-request-id": "req-500" });

    await expect(c.invoke(c.prepare({ id: "u1" }))).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    expect(ctx.reported.get("upstreamRequestId")).toBe("req-500");
  });

  it("reports before the body is read, so an exchange that never finished carries it", async () => {
    // What a caller most needs about an exchange that failed is the upstream's own id for it.
    // Read after the body, there is nothing to report when the body is what failed.
    const { c, ctx } = client(
      () =>
        new Response("x".repeat(64), {
          status: 200,
          headers: { "x-request-id": "req-too-big" },
        }),
      { metadata, maxResponseBytes: 8 },
    );

    await expect(c.request(c.prepare({ id: "u1" }))).rejects.toMatchObject({
      code: "UPSTREAM_CONTRACT_VIOLATION",
    });
    expect(ctx.reported.get("upstreamRequestId")).toBe("req-too-big");
  });

  it("reports for a body whose stream breaks part way through", async () => {
    const { c, ctx } = client(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
              controller.error(new Error("the connection went"));
            },
          }),
          { status: 200, headers: { "x-request-id": "req-broken" } },
        ),
      { metadata },
    );

    await expect(c.request(c.prepare({ id: "u1" }))).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    expect(ctx.reported.get("upstreamRequestId")).toBe("req-broken");
  });
});
