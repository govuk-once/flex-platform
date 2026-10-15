import { describe, expect, it } from "vitest";

import { bearerToken } from "./bearer-token.ts";

describe("bearerToken", () => {
  it("reads the token from Bearer, one space, and the token", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toEqual({ token: "abc.def.ghi" });
  });

  it.each([
    [undefined, true, "no-header"],
    ["", true, "no-header"],
    ["Bearer", true, "no-token"],
    ["Bearer ", true, "no-token"],
    ["Basic abc", false, "scheme"],
    ["Bearerabc.def.ghi", false, "scheme"],
    // WAF counts each form as a different token.
    ["bearer abc.def.ghi", false, "scheme"],
    ["BEARER abc.def.ghi", false, "scheme"],
    ["Bearer  abc.def.ghi", false, "parts"],
    [" Bearer abc", false, "scheme"],
    ["Bearer\tabc", false, "scheme"],
    ["Bearer abc def", false, "parts"],
    ["Bearer abc ", false, "parts"],
  ])("refuses %j", (value, missing, reason) => {
    expect(bearerToken(value)).toEqual({ missing, reason });
  });
});
