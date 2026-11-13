import { describe, expect, it } from "vitest";

import { rs256JwtPayload } from "./rs256-jwt-payload.ts";

const MAX_LENGTH = 4096;

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

const HEADER = segment({ alg: "RS256", kid: "key-1" });
const PAYLOAD = segment({ iss: "https://issuer.example", exp: 1_800_000_000 });
// Any base64url text stands in for a signature, which nothing here checks.
const SIGNATURE = "c2lnbmF0dXJl";

const TOKEN = `${HEADER}.${PAYLOAD}.${SIGNATURE}`;

describe("rs256JwtPayload", () => {
  it("gives the payload of a token in an RS256 JWT's shape", () => {
    expect(rs256JwtPayload(TOKEN, MAX_LENGTH)).toEqual({
      iss: "https://issuer.example",
      exp: 1_800_000_000,
    });
  });

  it("accepts a token of exactly the longest length, and no longer", () => {
    expect(rs256JwtPayload(TOKEN, TOKEN.length)).toBeTypeOf("object");
    expect(rs256JwtPayload(TOKEN, TOKEN.length - 1)).toBe("length");
  });

  // Segments are base64url, whose - and _ standard base64 doesn't use.
  it("decodes the URL-safe alphabet", () => {
    const payload = segment({ note: "~~~>>>???" });
    expect(payload).toMatch(/[-_]/);

    expect(
      rs256JwtPayload(`${HEADER}.${payload}.${SIGNATURE}`, MAX_LENGTH),
    ).toEqual({ note: "~~~>>>???" });
  });

  it.each([
    ["an empty token", "", "segments"],
    ["two segments", `${HEADER}.${PAYLOAD}`, "segments"],
    ["four segments", `${TOKEN}.extra`, "segments"],
    ["a header that isn't base64url", `a+b.${PAYLOAD}.${SIGNATURE}`, "header"],
    [
      "a header that isn't JSON",
      `bm90IGpzb24.${PAYLOAD}.${SIGNATURE}`,
      "header",
    ],
    [
      "a header that is a JSON array",
      `${segment([1])}.${PAYLOAD}.${SIGNATURE}`,
      "header",
    ],
    ["no algorithm", `${segment({})}.${PAYLOAD}.${SIGNATURE}`, "algorithm"],
    [
      "alg none",
      `${segment({ alg: "none" })}.${PAYLOAD}.${SIGNATURE}`,
      "algorithm",
    ],
    [
      "alg HS256",
      `${segment({ alg: "HS256" })}.${PAYLOAD}.${SIGNATURE}`,
      "algorithm",
    ],
    [
      "an algorithm in another case",
      `${segment({ alg: "rs256" })}.${PAYLOAD}.${SIGNATURE}`,
      "algorithm",
    ],
    [
      "a payload that isn't JSON",
      `${HEADER}.bm90IGpzb24.${SIGNATURE}`,
      "payload",
    ],
    [
      "a payload that is a JSON string",
      `${HEADER}.${segment("text")}.${SIGNATURE}`,
      "payload",
    ],
    ["an empty signature", `${HEADER}.${PAYLOAD}.`, "signature"],
    // A decoder ignores these bits, so one signature could be written 16 ways.
    [
      "a signature with its spare bits set",
      `${HEADER}.${PAYLOAD}.AR`,
      "signature",
    ],
    [
      "a signature that isn't base64url",
      `${HEADER}.${PAYLOAD}.c2l=`,
      "signature",
    ],
    ["a space in the token", `${HEADER}.${PAYLOAD}. ${SIGNATURE}`, "signature"],
  ])("names what %s lacks", (_, token, fault) => {
    expect(rs256JwtPayload(token, MAX_LENGTH)).toBe(fault);
  });

  // The first fault found is the one named, so a log line never depends on what else is wrong.
  it("names the length before anything else", () => {
    expect(rs256JwtPayload("a".repeat(MAX_LENGTH + 1), MAX_LENGTH)).toBe(
      "length",
    );
  });
});
