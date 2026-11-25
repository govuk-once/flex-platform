import { describe, expect, it } from "vitest";

import { readCallerToken } from "./caller-token.ts";

const segment = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const tokenWith = (claims: unknown) =>
  [segment({ alg: "EdDSA" }), segment(claims), "c2lnbmF0dXJl"].join(".");

const CLAIMS = { pairwiseId: "user-a", pushId: "push-a" };

describe("readCallerToken", () => {
  it("reads the caller's pairwise ID and push ID, and keeps the token as it was sent", () => {
    const token = tokenWith({ ...CLAIMS, service: "app" });

    expect(readCallerToken(token)).toEqual({
      caller: { pairwiseId: "user-a", pushId: "push-a" },
      token,
    });
  });

  it.each<[string, string | null | undefined]>([
    ["no token", undefined],
    ["a missing header", null],
    ["an empty token", ""],
    ["two segments", `${segment({})}.${segment(CLAIMS)}`],
    ["four segments", `${tokenWith(CLAIMS)}.extra`],
    ["a payload that is not JSON", `${segment({})}.bm90IGpzb24.c2ln`],
    ["a payload that is not an object", tokenWith(["user-a"])],
    ["no pairwise ID", tokenWith({ pushId: "push-a" })],
    ["an empty pairwise ID", tokenWith({ ...CLAIMS, pairwiseId: "" })],
    [
      "a pairwise ID that is not a string",
      tokenWith({ ...CLAIMS, pairwiseId: 7 }),
    ],
    ["no push ID", tokenWith({ pairwiseId: "user-a" })],
    ["an empty push ID", tokenWith({ ...CLAIMS, pushId: "" })],
  ])("reads nothing from %s", (_case, token) => {
    expect(readCallerToken(token)).toBeUndefined();
  });
});
