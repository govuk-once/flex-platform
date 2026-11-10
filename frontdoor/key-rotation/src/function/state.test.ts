import { describe, expect, it } from "vitest";

import { parseState } from "./state.ts";

const key = (fields: Record<string, unknown>) =>
  JSON.stringify({
    keys: [
      { kid: "20261106T120000Z", x: "AQID", privateKey: "AQID", ...fields },
    ],
    revoked: [],
  });

describe("parseState", () => {
  it("reads a key with when it starts, and when it stops once that is set", () => {
    expect(parseState(key({ signsFrom: 1 })).keys).toHaveLength(1);
    expect(
      parseState(key({ signsFrom: 1, signsUntil: 2 })).keys[0]?.signsUntil,
    ).toBe(2);
  });

  it("reads the keys revoked, each with when", () => {
    const revoked = [{ kid: "20261106T120000Z", revokedAt: 1 }];
    expect(parseState(JSON.stringify({ keys: [], revoked })).revoked).toEqual(
      revoked,
    );
  });

  it.each([
    ["a state without the keys revoked", JSON.stringify({ keys: [] })],
    [
      "a revoked key without when",
      JSON.stringify({ keys: [], revoked: [{ kid: "20261106T120000Z" }] }),
    ],
    [
      "a revoked key that isn't a key ID",
      JSON.stringify({ keys: [], revoked: [{ kid: "../x", revokedAt: 1 }] }),
    ],
  ])("refuses %s", (_, text) => {
    expect(() => parseState(text)).toThrow(
      "The key rotation state is not a key state",
    );
  });

  it.each([
    ["a key without its start", {}],
    ["a key that stops when it starts", { signsFrom: 1, signsUntil: 1 }],
    ["a key that stops before it starts", { signsFrom: 2, signsUntil: 1 }],
    ["an end that isn't a whole second", { signsFrom: 1, signsUntil: 1.5 }],
  ])("refuses %s", (_, fields) => {
    expect(() => parseState(key(fields))).toThrow(
      "The key rotation state is not a key state",
    );
  });
});
