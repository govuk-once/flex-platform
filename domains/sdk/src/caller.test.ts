import { describe, expect, it } from "vitest";

import { CALLER_HEADER, readCaller } from "./caller.ts";

// Built here rather than written down, so nothing in the repository looks like a token.
function token(claims: unknown, signature = "signature"): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.${signature}`;
}

describe("readCaller", () => {
  it("reads the caller and the values the gateway is sent from the token", () => {
    const identity = readCaller({
      [CALLER_HEADER]: token({
        pairwiseId: "user-1",
        scope: "read",
        count: 2,
        flag: true,
        nothing: null,
        nested: { not: "a value" },
      }),
    });
    expect(identity).toEqual({
      caller: { pairwiseId: "user-1" },
      secure: {
        values: {
          pairwiseId: "user-1",
          scope: "read",
          count: 2,
          flag: true,
          nothing: null,
        },
        signature: "signature",
      },
    });
  });

  it.each([
    ["no header", {}],
    ["a placeholder", { [CALLER_HEADER]: "placeholder" }],
    ["two segments", { [CALLER_HEADER]: "a.b" }],
    ["an empty signature", { [CALLER_HEADER]: token({ pairwiseId: "u" }, "") }],
    ["a payload that is not JSON", { [CALLER_HEADER]: "a.!!!.c" }],
    ["a payload that is not an object", { [CALLER_HEADER]: token([1]) }],
    ["no pairwise id", { [CALLER_HEADER]: token({ sub: "u" }) }],
    ["an empty pairwise id", { [CALLER_HEADER]: token({ pairwiseId: "" }) }],
    [
      "a pairwise id that is not a string",
      { [CALLER_HEADER]: token({ pairwiseId: 1 }) },
    ],
  ])("reads no caller from %s", (_, headers) => {
    expect(readCaller(headers)).toBeUndefined();
  });
});
