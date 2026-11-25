import { assert, describe, expect, it } from "vitest";

import type { ProxyEvent } from "./rest-api.ts";
import { requestFrom, resultFrom } from "./rest-api.ts";

function eventWith(fields: Partial<ProxyEvent>): ProxyEvent {
  return {
    httpMethod: "GET",
    path: "/v1/todos",
    multiValueHeaders: null,
    multiValueQueryStringParameters: null,
    body: null,
    isBase64Encoded: false,
    ...fields,
  };
}

describe("requestFrom", () => {
  it("keeps every value of a repeated header and query parameter, and reads header names in any case", () => {
    const request = requestFrom(
      eventWith({
        multiValueHeaders: { "X-Flex-Secure": ["token"], Accept: ["a", "b"] },
        multiValueQueryStringParameters: { tag: ["a", "b"], page: ["2"] },
      }),
    );

    const url = new URL(request.url);

    expect(url.searchParams.getAll("tag")).toEqual(["a", "b"]);
    expect(url.searchParams.get("page")).toBe("2");
    expect(request.headers.get("x-flex-secure")).toBe("token");
    expect(request.headers.get("accept")).toBe("a, b");
  });

  it("reads a body as text, or as bytes when it is base64", async () => {
    const text = requestFrom(
      eventWith({ httpMethod: "POST", body: '{"title":"Renew"}' }),
    );

    expect(await text.text()).toBe('{"title":"Renew"}');

    const bytes = requestFrom(
      eventWith({
        httpMethod: "POST",
        body: Buffer.from('{"title":"Renew"}').toString("base64"),
        isBase64Encoded: true,
      }),
    );

    expect(await bytes.text()).toBe('{"title":"Renew"}');
  });

  it("sends no body on a GET", async () => {
    const request = requestFrom(eventWith({ body: "ignored" }));

    expect(await request.text()).toBe("");
  });

  it.each([
    ["/v1/todos/a\\b", "/v1/todos/a%5Cb"],
    ["/v1/todos/a?b", "/v1/todos/a%3Fb"],
    ["/v1/todos/a#b", "/v1/todos/a%23b"],
    ["/v1/todos/a b", "/v1/todos/a%20b"],
    ["/v1/todos/%2e%2e", "/v1/todos/%252e%252e"],
  ])("keeps %j to its own segments", (path, pathname) => {
    const url = new URL(requestFrom(eventWith({ path })).url);

    expect(url.pathname).toBe(pathname);
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });

  it.each(["/v1/todos/..", "/v1/../v1/todos", "/v1/./todos"])(
    "sends %j, which a URL cannot hold, as a path no route matches",
    (path) => {
      expect(new URL(requestFrom(eventWith({ path })).url).pathname).toBe("/");
    },
  );
});

describe("resultFrom", () => {
  it("answers with the status, the headers and the body as text", async () => {
    const response = new Response('{"id":"1"}', {
      status: 201,
      headers: { "content-type": "application/json", "x-correlation-id": "1" },
    });

    const result = await resultFrom(response);

    assert.strictEqual(result.statusCode, 201);
    expect(result).toEqual({
      statusCode: 201,
      headers: { "content-type": "application/json", "x-correlation-id": "1" },
      body: '{"id":"1"}',
      isBase64Encoded: false,
    });
  });
});
