import { describe, expect, it } from "vitest";

import { requiredEnv } from "./required-env.ts";

describe("requiredEnv", () => {
  it("answers with the value, without the space around it", () => {
    expect(requiredEnv("NAME", { NAME: " value " })).toBe("value");
  });

  it.each([
    ["unset", {}],
    ["empty", { NAME: "" }],
    ["only space", { NAME: "  " }],
  ])("refuses a variable that is %s", (_, env) => {
    expect(() => requiredEnv("NAME", env)).toThrow(
      "Environment variable NAME must be set",
    );
  });
});
