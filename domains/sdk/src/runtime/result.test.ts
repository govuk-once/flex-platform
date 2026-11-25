import { assert, describe, expect, it } from "vitest";
import { z } from "zod";

import { responseFor, responseSchemas } from "./result.ts";

const schemas = responseSchemas({
  200: z.object({ id: z.string() }),
  204: null,
  404: z.object({ code: z.string() }),
});

describe("responseFor", () => {
  it("sends a declared status with its schema's output", async () => {
    const result = await responseFor(schemas, {
      status: 200,
      body: { id: "1", extra: true },
    });

    assert(result.kind === "response");

    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual({ id: "1" });
  });

  it("sends a status without a body, and a server error in the platform's body", async () => {
    const none = await responseFor(schemas, { status: 204 });

    const serverError = await responseFor(schemas, { status: 503 });

    assert(none.kind === "response");

    expect(none.response.body).toBeNull();
    expect(none.serverError).toBe(false);

    assert(serverError.kind === "response");

    expect(serverError.serverError).toBe(true);
    expect(await serverError.response.json()).toEqual({
      message: "Service unavailable",
      type: "server_error",
    });
  });

  it("checks a body with a schema whose refinements are async", async () => {
    const async = responseSchemas({
      200: z.object({
        id: z.string().refine((id) => Promise.resolve(id !== "")),
      }),
    });

    const sent = await responseFor(async, { status: 200, body: { id: "1" } });

    const refused = await responseFor(async, { status: 200, body: { id: "" } });

    expect(sent.kind).toBe("response");
    expect(refused).toEqual({
      kind: "problem",
      problem: "body: invalid, must match the schema for status 200",
    });
  });

  it("keeps a schema that throws apart from a body it refuses", async () => {
    const error = new Error("SYNTHETIC_SECRET");

    const throwing = responseSchemas({
      200: z.object({
        id: z.string().transform(() => {
          throw error;
        }),
      }),
    });

    expect(
      await responseFor(throwing, { status: 200, body: { id: "1" } }),
    ).toEqual({ kind: "failed", error });
  });

  it.each<[string, unknown, string]>([
    [
      "not an object",
      [200],
      "result: invalid type, must be an object of status and body",
    ],
    [
      "missing",
      undefined,
      "result: invalid type, must be an object of status and body",
    ],
    [
      "a field beyond status and body",
      { status: 200, body: { id: "1" }, headers: {} },
      "result: unknown field, must be one of: status, body",
    ],
    [
      "no status",
      { body: { id: "1" } },
      "status: invalid type, must be a number",
    ],
    [
      "a status that is text",
      { status: "200" },
      "status: invalid type, must be a number",
    ],
    [
      "a server error with a body",
      { status: 503, body: {} },
      "body: not allowed, status 503 is a server error",
    ],
    [
      "an undeclared status",
      { status: 401 },
      "status: 401 not declared, must be one of: 200, 204, 404, 500, 502, 503, 504",
    ],
    [
      "a body for a status without one",
      { status: 204, body: {} },
      "body: not allowed, status 204 has no body",
    ],
    [
      "a body its schema refuses",
      { status: 404, body: { code: 1 } },
      "body: invalid, must match the schema for status 404",
    ],
  ])("refuses %s", async (_case, result, problem) => {
    expect(await responseFor(schemas, result)).toEqual({
      kind: "problem",
      problem,
    });
  });

  it.each<[string, z.ZodType, unknown]>([
    ["a BigInt", z.object({ id: z.bigint() }), { id: 1n }],
    ["nothing", z.any(), undefined],
  ])("refuses a body JSON cannot write: %s", async (_case, schema, body) => {
    expect(
      await responseFor(responseSchemas({ 200: schema }), {
        status: 200,
        body,
      }),
    ).toEqual({
      kind: "problem",
      problem: "body: invalid, must be a value JSON can write",
    });
  });
});
