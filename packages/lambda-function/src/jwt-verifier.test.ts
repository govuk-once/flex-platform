import { generateKeyPairSync, sign } from "node:crypto";

import type { Fetcher } from "aws-jwt-verify/https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createJwtVerifier,
  type JwtIssuer,
  KEYS_MAX_AGE_MS,
} from "./jwt-verifier.ts";

const NOW = 1_800_000_000;
const ISSUER = "https://issuer.example";
const KEYS_URI = `${ISSUER}/keys`;
const KID = "key-1";

const ISSUER_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 });
const OTHER_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 });

const KEYS = {
  keys: [
    {
      ...ISSUER_KEY.publicKey.export({ format: "jwk" }),
      kid: KID,
      alg: "RS256",
      use: "sig",
    },
  ],
};

function fakeFetcher(
  documents: Record<string, unknown> = { [KEYS_URI]: KEYS },
) {
  const fetched: string[] = [];
  const fetcher: Fetcher = {
    fetch: (uri) => {
      fetched.push(uri);
      const document = documents[uri];
      if (document === undefined) return Promise.reject(new Error(uri));
      return Promise.resolve(
        new TextEncoder().encode(JSON.stringify(document)).buffer,
      );
    },
  };
  return { fetcher, fetched };
}

const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

// A token from the issuer, signed with RS256 by `key`. Set a claim to undefined to leave it out.
function token(
  payload: Record<string, unknown> = {},
  key: typeof ISSUER_KEY = ISSUER_KEY,
): string {
  const header = base64url({ alg: "RS256", kid: KID });
  const body = base64url({
    iss: ISSUER,
    aud: "audience",
    exp: NOW + 300,
    team: "platform",
    ...payload,
  });
  const signature = sign(
    "sha256",
    Buffer.from(`${header}.${body}`),
    key.privateKey,
  ).toString("base64url");
  return `${header}.${body}.${signature}`;
}

const TRUSTED: JwtIssuer<"team"> = {
  issuer: ISSUER,
  audience: "audience",
  keysUri: KEYS_URI,
  checkClaims: (payload, reject) => {
    if (payload.team !== "platform") reject("team");
  },
};

describe("createJwtVerifier", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW * 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers with the payload of a token that verifies", async () => {
    const verify = createJwtVerifier([TRUSTED], fakeFetcher().fetcher);

    const verified = await verify(token());

    expect(verified).toMatchObject({ payload: { iss: ISSUER } });
  });

  it.each([
    ["two segments", "a.b"],
    ["padding", `${token()}=`],
    ["standard base64", token().replace(/./, "+")],
  ])(
    "refuses %s as malformed, before any keys are fetched",
    async (_, text) => {
      const { fetcher, fetched } = fakeFetcher();

      await expect(
        createJwtVerifier([TRUSTED], fetcher)(text),
      ).resolves.toEqual({
        reason: "malformed",
      });
      expect(fetched).toEqual([]);
    },
  );

  it("refuses an issuer it was not given, without fetching any keys", async () => {
    const { fetcher, fetched } = fakeFetcher();

    await expect(
      createJwtVerifier(
        [TRUSTED],
        fetcher,
      )(token({ iss: "https://other.example" })),
    ).resolves.toEqual({ reason: "issuer" });
    expect(fetched).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["an expired token", { exp: NOW - 1 }, "expired"],
    ["a token in the instant it expires", { exp: NOW }, "expired"],
    ["a token without an expiry", { exp: undefined }, "no-expiry"],
    ["a token not valid yet", { nbf: NOW + 60 }, "not-yet-valid"],
    ["another audience", { aud: "other" }, "audience"],
    ["a claim the caller refuses", { team: "other" }, "team"],
  ])("refuses %s", async (_, payload, reason) => {
    const verify = createJwtVerifier([TRUSTED], fakeFetcher().fetcher);

    await expect(verify(token(payload))).resolves.toEqual({ reason });
  });

  it("refuses a token signed with a key the issuer doesn't publish", async () => {
    const verify = createJwtVerifier([TRUSTED], fakeFetcher().fetcher);

    await expect(verify(token({}, OTHER_KEY))).resolves.toEqual({
      reason: "signature",
    });
  });

  it("throws when the issuer's keys can't be fetched, so the request fails closed", async () => {
    const verify = createJwtVerifier([TRUSTED], fakeFetcher({}).fetcher);

    await expect(verify(token())).rejects.toThrow();
  });

  it("fetches the issuer's keys again once they are too old", async () => {
    const { fetcher, fetched } = fakeFetcher();
    const verify = createJwtVerifier([TRUSTED], fetcher);

    await verify(token());
    await verify(token());
    vi.advanceTimersByTime(KEYS_MAX_AGE_MS);
    await verify(token({ exp: NOW + KEYS_MAX_AGE_MS / 1000 + 300 }));

    expect(fetched).toEqual([KEYS_URI, KEYS_URI]);
  });
});
