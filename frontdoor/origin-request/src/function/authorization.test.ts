import { describe, expect, it } from "vitest";

import { authorizationToken } from "./authorization.ts";

describe("authorizationToken", () => {
  it("reads the token from the authorization header", () => {
    const headers = {
      authorization: [{ key: "Authorization", value: "Bearer abc.def.ghi" }],
    };

    expect(authorizationToken(headers)).toEqual({ token: "abc.def.ghi" });
  });

  it.each([[{}], [{ authorization: [] }]])(
    "refuses a request with no authorization header: %j",
    (headers) => {
      expect(authorizationToken(headers)).toEqual({
        missing: true,
        reason: "no-header",
      });
    },
  );

  it("refuses a repeated authorization header", () => {
    const repeated = {
      authorization: [
        { key: "Authorization", value: "Bearer abc.def.ghi" },
        { key: "Authorization", value: "Bearer jkl.mno.pqr" },
      ],
    };

    expect(authorizationToken(repeated)).toEqual({
      missing: false,
      reason: "repeated",
    });
  });
});
