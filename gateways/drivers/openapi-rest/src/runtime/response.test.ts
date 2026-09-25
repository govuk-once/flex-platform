import { GatewayError } from "@repo/gateway-runtime";
import { describe, expect, it } from "vitest";

import { errorForStatus, parseJsonBody } from "./response.ts";

describe("errorForStatus", () => {
  it.each([
    [400, "UPSTREAM_REJECTED"],
    [401, "UPSTREAM_REJECTED"],
    [403, "UPSTREAM_REJECTED"],
    [404, "NOT_FOUND"],
    [409, "UPSTREAM_REJECTED"],
    [422, "UPSTREAM_REJECTED"],
    [429, "RATE_LIMITED"],
    [500, "UPSTREAM_ERROR"],
    [502, "UPSTREAM_ERROR"],
    [503, "UPSTREAM_ERROR"],
    [504, "UPSTREAM_ERROR"],
    [203, "UPSTREAM_CONTRACT_VIOLATION"],
    [301, "UPSTREAM_CONTRACT_VIOLATION"],
    [302, "UPSTREAM_CONTRACT_VIOLATION"],
    [100, "UPSTREAM_CONTRACT_VIOLATION"],
  ])("maps %i to %s", (status, code) => {
    const err = errorForStatus(status, "op", "GET /x");
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.code).toBe(code);
  });

  it("names the operation, template and status only", () => {
    expect(errorForStatus(404, "getUser", "GET /users/{id}").message).toBe(
      'Upstream returned 404 for operation "getUser" (GET /users/{id})',
    );
  });
});

describe("parseJsonBody", () => {
  const where = 'for operation "op" (GET /x)';

  it("returns null for an empty body", () => {
    expect(parseJsonBody("", where)).toBeNull();
  });

  it("parses JSON", () => {
    expect(parseJsonBody('{"a":[1]}', where)).toEqual({ a: [1] });
  });

  it("throws a contract violation for non-JSON, naming the request only", () => {
    expect(() => parseJsonBody("<html>", where)).toThrow(
      expect.objectContaining({
        code: "UPSTREAM_CONTRACT_VIOLATION",
        message:
          'Upstream response body is not JSON for operation "op" (GET /x)',
      }),
    );
  });
});
