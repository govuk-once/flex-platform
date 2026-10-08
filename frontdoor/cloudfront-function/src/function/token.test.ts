import { describe, expect, it } from "vitest";

import {
  base64url,
  CLIENT_ID,
  CONFIG,
  ISSUER,
  NOW,
  token,
} from "../../test/helpers.ts";
import { checkToken } from "./token.ts";

const OTHER_ISSUER =
  "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_test";

function check(authorization: string | undefined) {
  return checkToken(authorization, CONFIG.issuers, NOW);
}

describe("checkToken", () => {
  it("accepts a well-formed access token from a trusted issuer", () => {
    expect(check(`Bearer ${token()}`)).toBeUndefined();
  });

  // The scheme is case-insensitive (RFC 9110 11.1), and one or more spaces may follow it
  // (RFC 6750 2.1).
  it.each([
    ["a lowercase scheme", `bearer ${token()}`],
    ["an uppercase scheme", `BEARER ${token()}`],
    ["two spaces after the scheme", `Bearer  ${token()}`],
  ])("accepts %s", (_, authorization) => {
    expect(check(authorization)).toBeUndefined();
  });

  it("accepts a token of exactly 4,096 characters", () => {
    const [header, payload] = token().split(".");
    const signature = "a".repeat(4096 - header!.length - payload!.length - 2);
    const exact = `${header}.${payload}.${signature}`;
    expect(exact).toHaveLength(4096);

    expect(check(`Bearer ${exact}`)).toBeUndefined();
  });

  it("accepts a token from any trusted issuer and any of its clients", () => {
    const issuers = [
      ...CONFIG.issuers,
      { issuer: OTHER_ISSUER, clientIds: ["test-client", "other-client"] },
    ];

    expect(
      checkToken(
        `Bearer ${token({}, { iss: OTHER_ISSUER, client_id: "other-client" })}`,
        issuers,
        NOW,
      ),
    ).toBeUndefined();
  });

  // Each client belongs to one pool, so a client trusted in another pool doesn't count.
  it("refuses a client trusted only under another issuer", () => {
    const issuers = [
      ...CONFIG.issuers,
      { issuer: OTHER_ISSUER, clientIds: ["test-client"] },
    ];

    expect(
      checkToken(
        `Bearer ${token({}, { iss: OTHER_ISSUER, client_id: CLIENT_ID })}`,
        issuers,
        NOW,
      ),
    ).toEqual({ event: "cff_token_invalid", reason: "client" });
  });

  it("trusts nothing with no issuers", () => {
    expect(checkToken(`Bearer ${token()}`, [], NOW)).toEqual({
      event: "cff_token_invalid",
      reason: "issuer",
    });
  });

  // Built from raw JSON: JSON.stringify would write Infinity as null.
  it("refuses an expiry that parses as infinity", () => {
    const [header, , signature] = token().split(".");
    const payload = Buffer.from(
      `{"iss":"${ISSUER}","client_id":"${CLIENT_ID}","token_use":"access","exp":1e400}`,
    ).toString("base64url");

    expect(check(`Bearer ${header}.${payload}.${signature}`)).toEqual({
      event: "cff_token_invalid",
      reason: "expiry",
    });
  });

  it.each([
    ["no header", undefined, "no-header"],
    ["an empty header", "", "no-header"],
    ["Bearer alone", "Bearer", "no-token"],
    ["Bearer and a space", "Bearer ", "no-token"],
  ])("reports %s as missing", (_, authorization, reason) => {
    expect(check(authorization)).toEqual({
      event: "cff_token_missing",
      reason,
    });
  });

  it.each([
    ["another scheme", `Basic ${token()}`, "scheme"],
    ["a scheme with a leading space", ` Bearer ${token()}`, "scheme"],
    ["no scheme", token(), "scheme"],
    ["more than one token", `Bearer ${token()} extra`, "parts"],
    ["an overlong token", `Bearer ${"a".repeat(4097)}`, "length"],
    [
      "two segments",
      `Bearer ${token().split(".").slice(0, 2).join(".")}`,
      "segments",
    ],
    ["four segments", `Bearer ${token()}.extra`, "segments"],
    [
      "a header that isn't base64url",
      `Bearer a+b.${token().split(".")[1]}.c2ln`,
      "header",
    ],
    [
      "a header that isn't JSON",
      `Bearer bm90IGpzb24.${token().split(".")[1]}.c2ln`,
      "header",
    ],
    [
      "a header that is a JSON array",
      `Bearer ${base64url([1])}.${token().split(".")[1]}.c2ln`,
      "header",
    ],
    ["alg none", `Bearer ${token({ alg: "none" })}`, "algorithm"],
    ["alg HS256", `Bearer ${token({ alg: "HS256" })}`, "algorithm"],
    [
      "a payload that isn't JSON",
      `Bearer ${token().split(".")[0]}.bm90IGpzb24.c2ln`,
      "payload",
    ],
    [
      "an empty signature",
      `Bearer ${token().split(".").slice(0, 2).join(".")}.`,
      "signature",
    ],
    [
      "a signature that isn't base64url",
      `Bearer ${token().split(".").slice(0, 2).join(".")}.c2l=`,
      "signature",
    ],
    [
      "an untrusted issuer",
      `Bearer ${token({}, { iss: "https://example.com" })}`,
      "issuer",
    ],
    ["no issuer", `Bearer ${token({}, { iss: undefined })}`, "issuer"],
    [
      "an untrusted client",
      `Bearer ${token({}, { client_id: "another-client" })}`,
      "client",
    ],
    ["no client", `Bearer ${token({}, { client_id: undefined })}`, "client"],
    [
      "a client that isn't a string",
      `Bearer ${token({}, { client_id: [CLIENT_ID] })}`,
      "client",
    ],
    ["an ID token", `Bearer ${token({}, { token_use: "id" })}`, "token-use"],
    ["no expiry", `Bearer ${token({}, { exp: undefined })}`, "expiry"],
    [
      "an expiry that isn't a number",
      `Bearer ${token({}, { exp: "soon" })}`,
      "expiry",
    ],
  ])("reports %s as invalid", (_, authorization, reason) => {
    expect(check(authorization)).toEqual({
      event: "cff_token_invalid",
      reason,
    });
  });

  it.each([
    ["expired a second ago", NOW - 1],
    ["expiring now", NOW],
  ])("reports a token %s as expired", (_, exp) => {
    expect(check(`Bearer ${token({}, { exp })}`)).toEqual({
      event: "cff_token_expired",
      reason: "expired",
    });
  });

  it("accepts a token expiring a second from now", () => {
    expect(check(`Bearer ${token({}, { exp: NOW + 1 })}`)).toBeUndefined();
  });

  // Segments are base64url, whose - and _ standard base64 doesn't use.
  it("decodes the URL-safe alphabet", () => {
    const payload = {
      iss: ISSUER,
      client_id: CLIENT_ID,
      token_use: "access",
      exp: NOW + 60,
      note: "~~~>>>???",
    };
    const encoded = base64url(payload);
    expect(encoded).toMatch(/[-_]/);

    const [header, , signature] = token().split(".");
    expect(check(`Bearer ${header}.${encoded}.${signature}`)).toBeUndefined();
  });
});
