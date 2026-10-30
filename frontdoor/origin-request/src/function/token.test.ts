import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  base64url,
  CLIENT_ID,
  fakeFetcher,
  ISSUER,
  ISSUER_KEY,
  ISSUERS,
  jwks,
  jwksUri,
  KID,
  NOW,
  OTHER_KEY,
  token,
} from "../../test/helpers.ts";
import { createTokenVerifier } from "./token.ts";

const OTHER_ISSUER =
  "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_other";

function verifier(documents?: Record<string, unknown>) {
  const fake = fakeFetcher(
    documents ?? { [jwksUri(ISSUER)]: jwks([{ kid: KID, key: ISSUER_KEY }]) },
  );
  return { verify: createTokenVerifier(ISSUERS, fake.fetcher), ...fake };
}

describe("createTokenVerifier", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW * 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a token the issuer signed", async () => {
    const { verify } = verifier();

    await expect(verify(token())).resolves.toBeUndefined();
  });

  it("fetches each issuer's keys once, from its well-known address", async () => {
    const { verify, fetched } = verifier();

    await verify(token());
    await verify(token());

    expect(fetched).toEqual([jwksUri(ISSUER)]);
  });

  it("verifies each token against its own issuer's keys and clients", async () => {
    const fake = fakeFetcher({
      [jwksUri(ISSUER)]: jwks([{ kid: KID, key: ISSUER_KEY }]),
      [jwksUri(OTHER_ISSUER)]: jwks([{ kid: KID, key: OTHER_KEY }]),
    });
    const verify = createTokenVerifier(
      [...ISSUERS, { issuer: OTHER_ISSUER, clientIds: ["other-client"] }],
      fake.fetcher,
    );
    const other = { iss: OTHER_ISSUER, client_id: "other-client" };

    await expect(
      verify(token({ payload: other, key: OTHER_KEY })),
    ).resolves.toBeUndefined();
    await expect(verify(token({ payload: other }))).resolves.toEqual({
      reason: "signature",
    });
    await expect(
      verify(token({ payload: { iss: OTHER_ISSUER }, key: OTHER_KEY })),
    ).resolves.toEqual({ reason: "client" });
  });

  it.each([
    ["malformed", "not-a-token"],
    ["malformed", `${base64url("text")}.${base64url({})}.c2ln`],
    ["issuer", token({ payload: { iss: OTHER_ISSUER } })],
    ["issuer", token({ payload: { iss: undefined } })],
    // Cognito's global issuer format is a different issuer unless the config names it.
    [
      "issuer",
      token({
        payload: {
          iss: "https://issuer-cognito-idp.eu-west-2.amazonaws.com/eu-west-2_example",
        },
      }),
    ],
    ["issuer", token({ payload: { iss: "constructor" } })],
    ["key", token({ header: { kid: undefined } })],
    ["key", token({ header: { kid: "key-2" } })],
    ["signature", token({ key: OTHER_KEY })],
    ["algorithm", token({ header: { alg: "RS512" } })],
    ["algorithm", token({ header: { alg: "none" } })],
    ["expired", token({ payload: { exp: NOW - 1 } })],
    ["not-yet-valid", token({ payload: { nbf: NOW + 60 } })],
    ["no-expiry", token({ payload: { exp: undefined } })],
    ["token-use", token({ payload: { token_use: "id" } })],
    ["token-use", token({ payload: { token_use: undefined } })],
    ["client", token({ payload: { client_id: "another-client" } })],
    ["client", token({ payload: { client_id: [CLIENT_ID] } })],
    ["username", token({ payload: { username: undefined } })],
    ["username", token({ payload: { username: "" } })],
    ["username", token({ payload: { username: 42 } })],
  ])("refuses a token as %s", async (reason, refused) => {
    const { verify } = verifier();

    await expect(verify(refused)).resolves.toEqual({ reason });
  });

  // A key published without an algorithm verifies whatever algorithm the token names.
  it("refuses a token the issuer's key verifies under another algorithm than RS256", async () => {
    const [published] = jwks([{ kid: KID, key: ISSUER_KEY }]).keys;
    const { verify } = verifier({
      [jwksUri(ISSUER)]: { keys: [{ ...published, alg: undefined }] },
    });

    await expect(
      verify(token({ header: { alg: "RS512" }, digest: "sha512" })),
    ).resolves.toEqual({ reason: "algorithm" });
  });

  // The signature's last character has spare bits, which a decoder ignores.
  it("refuses another encoding of a token the issuer signed, which would verify", async () => {
    const { verify } = verifier();
    const signed = token();
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const variant =
      signed.slice(0, -1) + alphabet[alphabet.indexOf(signed.slice(-1)) + 1]!;
    const signature = (value: string) =>
      Buffer.from(value.split(".")[2]!, "base64url");
    expect(signature(variant)).toEqual(signature(signed));

    await expect(verify(signed)).resolves.toBeUndefined();
    await expect(verify(variant)).resolves.toEqual({ reason: "malformed" });
  });

  it("refuses a token signed by a key the issuer doesn't publish", async () => {
    const { verify, fetched } = verifier();
    await verify(token());

    // An unknown key ID fetches the keys again, in case the issuer rotated them, then not again
    // while the library waits.
    await expect(
      verify(token({ header: { kid: "key-2" }, key: OTHER_KEY })),
    ).resolves.toEqual({ reason: "key" });
    await expect(
      verify(token({ header: { kid: "key-3" }, key: OTHER_KEY })),
    ).resolves.toEqual({ reason: "key" });
    expect(fetched).toEqual([jwksUri(ISSUER), jwksUri(ISSUER)]);
  });

  it("throws when the issuer's keys can't be fetched, so the request fails closed", async () => {
    const { verify } = verifier({});

    await expect(verify(token())).rejects.toThrow();
  });

  it("throws when the issuer's keys aren't a JWKS", async () => {
    const { verify } = verifier({ [jwksUri(ISSUER)]: { keys: "none" } });

    await expect(verify(token())).rejects.toThrow();
  });
});
