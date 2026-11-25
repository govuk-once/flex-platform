import { describe, expect, it } from "vitest";
import { z } from "zod";

import { compileRoute } from "./compile-route.ts";

const handler = () => ({ status: 204 });

const responses = { 204: null };

describe("compileRoute", () => {
  it.each([
    [
      "an invalid key",
      "GET todos",
      { handler, responses },
      'routes["GET todos"]: invalid route key',
    ],
    [
      "a handler that is not a function",
      "GET /v1/todos",
      { handler: {}, responses },
      'routes["GET /v1/todos"]: handler is not a function',
    ],
    [
      "a path parameter it cannot read",
      "GET /v1/todos/{id}",
      { handler, params: z.object({ id: z.date() }), responses },
      'routes["GET /v1/todos/{id}"]: failed to read path parameters',
    ],
  ])("throws for %s", (_case, key, route, message) => {
    expect(() => compileRoute(key, route)).toThrow(new TypeError(message));
  });
});
