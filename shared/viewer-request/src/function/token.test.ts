import { describe, expect, it } from "vitest";

import { AUDIENCE, CONFIG, ISSUER, NOW, token } from "../../test/helpers.ts";
import { checkToken } from "./token.ts";

function check(value: string | undefined) {
  return checkToken(value, CONFIG, NOW);
}

describe("checkToken", () => {
  it("accepts a well-formed token from the issuer, for the audience", () => {
    expect(check(token())).toBeUndefined();
  });

  it("accepts a token of exactly 8,192 characters", () => {
    const signed = token();
    const unsigned = signed.slice(0, signed.lastIndexOf("."));
    const exact = `${unsigned}.${"A".repeat(8192 - unsigned.length - 1)}`;
    expect(exact).toHaveLength(8192);

    expect(check(exact)).toBeUndefined();
    expect(check(`${exact}AAAA`)).toEqual({
      event: "viewer_request_token_invalid",
      reason: "length",
    });
  });

  // A JWT may name several audiences. The origin's verifier accepts a list that holds ours.
  it("accepts the audience among several", () => {
    expect(
      check(token({}, { aud: ["https://elsewhere.example", AUDIENCE] })),
    ).toBeUndefined();
  });

  it.each([
    ["no header", undefined],
    ["an empty header", ""],
  ])("reports %s as missing", (_, value) => {
    expect(check(value)).toEqual({
      event: "viewer_request_token_missing",
      reason: "no-header",
    });
  });

  it.each([
    // The header holds the token alone, so WAF counts each token under one value.
    ["a scheme before the token", `Bearer ${token()}`, "header"],
    ["a space after the token", `${token()} `, "signature"],
    ["two segments", token().split(".").slice(0, 2).join("."), "segments"],
    ["four segments", `${token()}.extra`, "segments"],
    ["alg none", token({ alg: "none" }), "algorithm"],
    ["alg HS256", token({ alg: "HS256" }), "algorithm"],
    ["alg ES256", token({ alg: "ES256" }), "algorithm"],
    [
      "a payload that isn't JSON",
      `${token().split(".")[0]}.bm90IGpzb24.c2ln`,
      "payload",
    ],
    [
      "an empty signature",
      `${token().split(".").slice(0, 2).join(".")}.`,
      "signature",
    ],
    [
      "a signature with its spare bits set",
      `${token().split(".").slice(0, 2).join(".")}.AR`,
      "signature",
    ],
    ["another issuer", token({}, { iss: "https://example.com" }), "issuer"],
    [
      "the issuer with a trailing slash",
      token({}, { iss: `${ISSUER}/` }),
      "issuer",
    ],
    ["no issuer", token({}, { iss: undefined }), "issuer"],
    ["an issuer that isn't a string", token({}, { iss: [ISSUER] }), "issuer"],
    // GitHub's default audience is the repository owner's URL, which any workflow can get.
    [
      "GitHub's default audience",
      token({}, { aud: "https://github.com/example-org" }),
      "audience",
    ],
    [
      "another stage's audience",
      token({}, { aud: "https://other.flex-shared.example/ci" }),
      "audience",
    ],
    [
      "the audience with a trailing slash",
      token({}, { aud: `${AUDIENCE}/` }),
      "audience",
    ],
    ["no audience", token({}, { aud: undefined }), "audience"],
    ["an empty list of audiences", token({}, { aud: [] }), "audience"],
    [
      "a list of other audiences",
      token({}, { aud: ["https://elsewhere.example"] }),
      "audience",
    ],
    [
      "an audience that isn't a string",
      token({}, { aud: { [AUDIENCE]: true } }),
      "audience",
    ],
    ["no expiry", token({}, { exp: undefined }), "expiry"],
    ["an expiry that isn't a number", token({}, { exp: "soon" }), "expiry"],
  ])("reports %s as invalid", (_, value, reason) => {
    expect(check(value)).toEqual({
      event: "viewer_request_token_invalid",
      reason,
    });
  });

  // Built from raw JSON: JSON.stringify would write Infinity as null.
  it("refuses an expiry that parses as infinity", () => {
    const [header, , signature] = token().split(".");
    const payload = Buffer.from(
      `{"iss":"${ISSUER}","aud":"${AUDIENCE}","exp":1e400}`,
    ).toString("base64url");

    expect(check(`${header}.${payload}.${signature}`)).toEqual({
      event: "viewer_request_token_invalid",
      reason: "expiry",
    });
  });

  it.each([
    ["expired a second ago", NOW - 1],
    ["expiring now", NOW],
  ])("reports a token %s as expired", (_, exp) => {
    expect(check(token({}, { exp }))).toEqual({
      event: "viewer_request_token_expired",
      reason: "expired",
    });
  });

  it("accepts a token expiring a second from now", () => {
    expect(check(token({}, { exp: NOW + 1 }))).toBeUndefined();
  });

  // An expired token from elsewhere is not ours to call expired.
  it("checks who a token is from and for before when it expires", () => {
    expect(check(token({}, { iss: "https://example.com", exp: NOW }))).toEqual({
      event: "viewer_request_token_invalid",
      reason: "issuer",
    });
    expect(
      check(token({}, { aud: "https://elsewhere.example", exp: NOW })),
    ).toEqual({ event: "viewer_request_token_invalid", reason: "audience" });
  });
});
