import { describe, expect, it } from "vitest";

import { parseUpstream } from "./upstream.ts";

describe("parseUpstream", () => {
  it("parses a method and a literal path", () => {
    expect(parseUpstream("GET /v1/users")).toEqual({
      method: "GET",
      template: "/v1/users",
      parts: [{ kind: "literal", value: "/v1/users" }],
      params: [],
    });
  });

  it("splits path parameters from literals", () => {
    const parsed = parseUpstream("PUT /orgs/{orgId}/users/{id}.json");
    expect(parsed.method).toBe("PUT");
    expect(parsed.params).toEqual(["orgId", "id"]);
    expect(parsed.parts).toEqual([
      { kind: "literal", value: "/orgs/" },
      { kind: "param", name: "orgId" },
      { kind: "literal", value: "/users/" },
      { kind: "param", name: "id" },
      { kind: "literal", value: ".json" },
    ]);
  });

  it("accepts every supported method", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(parseUpstream(`${method} /x`).method).toBe(method);
    }
  });

  it.each([
    ["/no-method", /must be "<METHOD> \/<path>"/],
    ["FETCH /x", /unsupported method "FETCH"/],
    ["get /x", /unsupported method "get"/],
    ["GET x", /must start with "\/"/],
    ["GET /x?y=1", /query string, fragment or whitespace/],
    ["GET /x#frag", /query string, fragment or whitespace/],
    ["GET /x /y", /query string, fragment or whitespace/],
    ["GET /x/{id}/{id}", /more than once/],
    ["GET /x/{}", /invalid path parameter name/],
    ["GET /x/{1id}", /invalid path parameter name/],
    ["GET /x/{id", /unbalanced braces/],
    ["GET /x/id}", /unbalanced braces/],
    // A parameter's value would finish the escape, composing a segment the template never
    // showed: "/users/%2e%{id}" with id "2e" sends "/users/%2e%2e".
    ["GET /users/%2e%{id}/tail", /incomplete percent escape/],
    ["GET /users/%{id}", /incomplete percent escape/],
    ["GET /users/%2/x", /incomplete percent escape/],
    ["GET /discount/100%", /incomplete percent escape/],
    // Every spelling the URL parser resolves, which would move the request up and out of the
    // target's own path prefix.
    ["GET /../admin", /dot segment/],
    ["GET /./admin", /dot segment/],
    ["GET /%2e%2e/admin", /dot segment/],
    ["GET /%2E%2E/admin", /dot segment/],
    ["GET /.%2e/admin", /dot segment/],
    ["GET /%2e./admin", /dot segment/],
    ["GET /users/../admin", /dot segment/],
    ["GET /users/..", /dot segment/],
    ["GET /users/{id}/..", /dot segment/],
    // The URL parser reads these as separators too, so a "/"-only check would miss them.
    ["GET /..\\admin", /backslash/],
    ["GET /%2e%2e\\admin", /backslash/],
    ["GET /a\\..\\admin", /backslash/],
    ["GET /users\\{id}", /backslash/],
    ["GET /users/a\\b", /backslash/],
  ])("rejects %j", (upstream, message) => {
    expect(() => parseUpstream(upstream)).toThrowError(message);
  });

  // Neither check may catch a template that is merely dot-shaped or escape-shaped: only a whole
  // segment is a dot segment, and a complete escape is fine wherever it sits.
  it.each([
    "GET /users/{id}.json",
    "GET /files/a%2Fb",
    "GET /discount/100%25",
    "GET /users/...",
    "GET /users/a%2e%2e",
    "GET /users/..hidden",
    "GET /users/{id}..",
  ])("accepts %j", (upstream) => {
    expect(() => parseUpstream(upstream)).not.toThrowError();
  });
});
