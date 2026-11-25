import { describe, expect, it } from "vitest";

import { callerTokenAudience, isKeyId, keyIdFor } from "./caller-token.ts";

describe("callerTokenAudience", () => {
  it("names the environment's gateways", () => {
    expect(callerTokenAudience("production")).toBe("flex:production:gateways");
  });
});

describe("keyIdFor", () => {
  it("names the time, so IDs sort by age", () => {
    const kid = keyIdFor(new Date("2026-11-06T12:34:56.789Z"));
    expect(kid).toBe("20261106T123456Z");
    expect(isKeyId(kid)).toBe(true);
    expect([keyIdFor(new Date("2026-11-13T00:00:00Z")), kid].sort()).toEqual([
      kid,
      "20261113T000000Z",
    ]);
  });
});

describe("isKeyId", () => {
  it.each(["", "20261106T1234Z", "../20261106T123456Z", "20261106t123456z"])(
    "refuses %j",
    (kid) => {
      expect(isKeyId(kid)).toBe(false);
    },
  );
});
