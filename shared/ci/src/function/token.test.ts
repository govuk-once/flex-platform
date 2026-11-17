import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUDIENCE,
  base64url,
  CONFIG,
  fakeFetcher,
  ISSUER,
  ISSUER_KEY,
  jwks,
  KEYS_URI,
  KID,
  NOW,
  OTHER_KEY,
  OWNER_ID,
  REPOSITORY_ID,
  token,
} from "../../test/helpers.ts";
import {
  createTokenVerifier,
  KEYS_BACKOFF_MS,
  KEYS_MAX_AGE_MS,
} from "./token.ts";

// How long the library waits, after a key ID the issuer's keys didn't hold, to fetch them again.
const UNKNOWN_KEY_WAIT_MS = 10_000;

const PIPELINE = {
  repositoryId: REPOSITORY_ID,
  ownerId: OWNER_ID,
  environment: "development",
  runId: "12345678901",
};

function verifier(documents?: Record<string, unknown>) {
  const fake = fakeFetcher(documents);
  return { verify: createTokenVerifier(CONFIG, fake.fetcher), ...fake };
}

describe("createTokenVerifier", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW * 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a token the issuer signed, and says which pipeline it is from", async () => {
    const { verify } = verifier();

    await expect(verify(token())).resolves.toEqual(PIPELINE);
  });

  it("fetches the issuer's keys once, from the address it is given", async () => {
    const { verify, fetched } = verifier();

    await verify(token());
    await verify(token());

    expect(fetched).toEqual([KEYS_URI]);
  });

  it("accepts a token for several audiences, this one among them", async () => {
    const { verify } = verifier();

    await expect(
      verify(token({ payload: { aud: ["https://other.example", AUDIENCE] } })),
    ).resolves.toEqual(PIPELINE);
  });

  // A job outside any environment, or a claim that isn't text, has no environment to act on.
  it.each([[undefined], [42], [["development"]], [null]])(
    "gives no environment for the claim %j",
    async (environment) => {
      const { verify } = verifier();

      await expect(
        verify(token({ payload: { environment } })),
      ).resolves.toEqual({ ...PIPELINE, environment: undefined });
    },
  );

  // The run is only for the log, so one that isn't digits is left out, not refused.
  it.each([[undefined], [12345678901], ["run 1"], ["<script>"]])(
    "gives no run for the claim %j",
    async (run_id) => {
      const { verify } = verifier();

      await expect(verify(token({ payload: { run_id } }))).resolves.toEqual({
        ...PIPELINE,
        runId: undefined,
      });
    },
  );

  it.each([
    ["malformed", "not-a-token"],
    ["malformed", ""],
    ["malformed", `${base64url("text")}.${base64url({})}.c2ln`],
    ["malformed", `${token()}.extra`],
    // Two values of a repeated header, as Lambda joins them.
    ["malformed", `${token()},${token()}`],
    ["malformed", `Bearer ${token()}`],
    // An issuer that isn't text is not a token the library will read.
    ["malformed", token({ payload: { iss: [ISSUER] } })],
    ["issuer", token({ payload: { iss: "https://issuer.example" } })],
    ["issuer", token({ payload: { iss: undefined } })],
    ["issuer", token({ payload: { iss: `${ISSUER}/` } })],
    ["issuer", token({ payload: { iss: "constructor" } })],
    ["audience", token({ payload: { aud: "https://other.example/ci" } })],
    ["audience", token({ payload: { aud: undefined } })],
    ["audience", token({ payload: { aud: `${AUDIENCE}/` } })],
    // GitHub's default audience, the repository owner's address.
    ["audience", token({ payload: { aud: "https://github.com/example-org" } })],
    ["key", token({ header: { kid: undefined } })],
    ["key", token({ header: { kid: "key-2" } })],
    ["signature", token({ key: OTHER_KEY })],
    ["algorithm", token({ header: { alg: "RS512" } })],
    ["algorithm", token({ header: { alg: "none" } })],
    ["expired", token({ payload: { exp: NOW - 1 } })],
    // The instant it expires, which the CloudFront Function refuses too.
    ["expired", token({ payload: { exp: NOW } })],
    ["not-yet-valid", token({ payload: { nbf: NOW + 60 } })],
    ["no-expiry", token({ payload: { exp: undefined } })],
    ["repository", token({ payload: { repository_id: undefined } })],
    ["repository", token({ payload: { repository_id: 700000001 } })],
    ["repository", token({ payload: { repository_id: "" } })],
    ["repository", token({ payload: { repository_id: "70000 0001" } })],
    ["repository", token({ payload: { repository_id: [REPOSITORY_ID] } })],
    ["repository", token({ payload: { repository_owner_id: undefined } })],
    ["repository", token({ payload: { repository_owner_id: 90000001 } })],
    ["repository", token({ payload: { repository_owner_id: "example-org" } })],
  ])("refuses a token as %s", async (reason, refused) => {
    const { verify } = verifier();

    await expect(verify(refused)).resolves.toEqual({ reason });
  });

  it("refuses a token longer than any job's, without verifying it", async () => {
    const { verify, fetched } = verifier();
    const long = token({ payload: { padding: "a".repeat(8192) } });

    await expect(verify(long)).resolves.toEqual({ reason: "malformed" });
    expect(fetched).toEqual([]);
  });

  // Anyone can stand up an issuer. Its tokens never cost a fetch of GitHub's keys.
  it("refuses another issuer's token without fetching any keys", async () => {
    const { verify, fetched } = verifier();

    await expect(
      verify(
        token({ payload: { iss: "https://issuer.example" }, key: OTHER_KEY }),
      ),
    ).resolves.toEqual({ reason: "issuer" });
    expect(fetched).toEqual([]);
  });

  // The public key is public. Signed with it as an HMAC secret, a token passes a verifier that
  // lets the token choose its algorithm.
  it("refuses a token signed with the issuer's public key as an HMAC secret", async () => {
    const { verify } = verifier();
    const [header, payload] = token({ header: { alg: "HS256" } }).split(".");
    const secret = ISSUER_KEY.publicKey.export({ type: "spki", format: "pem" });
    const signature = createHmac("sha256", secret)
      .update(`${header}.${payload}`)
      .digest("base64url");

    await expect(verify(`${header}.${payload}.${signature}`)).resolves.toEqual({
      reason: "algorithm",
    });
  });

  // A key published without an algorithm verifies whatever algorithm the token names.
  it("refuses a token the issuer's key verifies under another algorithm than RS256", async () => {
    const [published] = jwks([{ kid: KID, key: ISSUER_KEY }]).keys;
    const { verify } = verifier({
      [KEYS_URI]: { keys: [{ ...published, alg: undefined }] },
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
      signed.slice(0, -1) +
      alphabet.charAt(alphabet.indexOf(signed.slice(-1)) + 1);
    const signature = (value: string) =>
      Buffer.from(value.slice(value.lastIndexOf(".") + 1), "base64url");
    expect(signature(variant)).toEqual(signature(signed));

    await expect(verify(signed)).resolves.toEqual(PIPELINE);
    await expect(verify(variant)).resolves.toEqual({ reason: "malformed" });
  });

  // A payload changed after signing: the repository it claims is no longer what was signed.
  it("refuses a token whose payload was changed after it was signed", async () => {
    const { verify } = verifier();
    const [header, , signature] = token().split(".");
    const forged = token({ payload: { repository_id: "700000002" } }).split(
      ".",
    )[1];

    await expect(verify(`${header}.${forged}.${signature}`)).resolves.toEqual({
      reason: "signature",
    });
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
    expect(fetched).toEqual([KEYS_URI, KEYS_URI]);
  });

  it("throws when the issuer's keys can't be fetched, so the request fails closed", async () => {
    const { verify } = verifier({});

    await expect(verify(token())).rejects.toThrow();
  });

  it("waits before fetching keys again after a fetch fails, failing closed meanwhile", async () => {
    const documents: Record<string, unknown> = {};
    const { verify, fetched } = verifier(documents);

    await expect(verify(token())).rejects.toThrow();
    await expect(verify(token())).rejects.toThrow();
    expect(fetched).toEqual([KEYS_URI]);

    documents[KEYS_URI] = jwks([{ kid: KID, key: ISSUER_KEY }]);
    vi.advanceTimersByTime(KEYS_BACKOFF_MS - 1);
    await expect(verify(token())).rejects.toThrow();
    expect(fetched).toHaveLength(1);

    vi.advanceTimersByTime(1);
    await expect(verify(token())).resolves.toEqual(PIPELINE);
    expect(fetched).toEqual([KEYS_URI, KEYS_URI]);
  });

  it("throws when the issuer's keys aren't a JWKS", async () => {
    const { verify } = verifier({ [KEYS_URI]: { keys: "none" } });

    await expect(verify(token())).rejects.toThrow();
  });

  it("waits before fetching keys again after an answer that isn't a JWKS", async () => {
    const documents: Record<string, unknown> = { [KEYS_URI]: { keys: "none" } };
    const { verify, fetched } = verifier(documents);

    await expect(verify(token())).rejects.toThrow();
    await expect(verify(token())).rejects.toThrow();
    await expect(verify(token())).rejects.toThrow();
    expect(fetched).toEqual([KEYS_URI]);

    documents[KEYS_URI] = jwks([{ kid: KID, key: ISSUER_KEY }]);
    vi.advanceTimersByTime(KEYS_BACKOFF_MS);
    await expect(verify(token())).resolves.toEqual(PIPELINE);
    expect(fetched).toEqual([KEYS_URI, KEYS_URI]);
  });

  it("accepts a token a second before it expires", async () => {
    const { verify } = verifier();

    await expect(verify(token({ payload: { exp: NOW + 1 } }))).resolves.toEqual(
      PIPELINE,
    );
  });

  it("keeps the issuer's keys until they are the maximum age old, then fetches them again", async () => {
    const { verify, fetched } = verifier();
    await verify(token({ payload: { exp: NOW + 3600 } }));

    vi.advanceTimersByTime(KEYS_MAX_AGE_MS - 1);
    await verify(token({ payload: { exp: NOW + 3600 } }));
    expect(fetched).toEqual([KEYS_URI]);

    vi.advanceTimersByTime(1);
    await expect(
      verify(token({ payload: { exp: NOW + 3600 } })),
    ).resolves.toEqual(PIPELINE);
    expect(fetched).toEqual([KEYS_URI, KEYS_URI]);
  });

  // The library alone would keep the key for as long as the instance lives.
  it("refuses a token signed by a key the issuer removed, once the keys it held are too old", async () => {
    const documents = { [KEYS_URI]: jwks([{ kid: KID, key: ISSUER_KEY }]) };
    const { verify } = verifier(documents);
    const signed = token({ payload: { exp: NOW + 3600 } });
    await expect(verify(signed)).resolves.toEqual(PIPELINE);

    documents[KEYS_URI] = jwks([{ kid: "key-2", key: OTHER_KEY }]);
    vi.advanceTimersByTime(KEYS_MAX_AGE_MS - 1);
    await expect(verify(signed)).resolves.toEqual(PIPELINE);

    vi.advanceTimersByTime(1);
    await expect(verify(signed)).resolves.toEqual({ reason: "key" });
  });

  it("fails closed when the keys it holds are too old and can't be fetched again", async () => {
    const documents: Record<string, unknown> = {
      [KEYS_URI]: jwks([{ kid: KID, key: ISSUER_KEY }]),
    };
    const { verify, fetched } = verifier(documents);
    const signed = token({ payload: { exp: NOW + 3600 } });
    await verify(signed);

    delete documents[KEYS_URI];
    vi.advanceTimersByTime(KEYS_MAX_AGE_MS);
    await expect(verify(signed)).rejects.toThrow();
    // Inside the back-off, without another fetch.
    await expect(verify(signed)).rejects.toThrow();
    expect(fetched).toEqual([KEYS_URI, KEYS_URI]);

    documents[KEYS_URI] = jwks([{ kid: KID, key: ISSUER_KEY }]);
    vi.advanceTimersByTime(KEYS_BACKOFF_MS);
    await expect(verify(signed)).resolves.toEqual(PIPELINE);
  });

  // The library's wait after an unknown key ID is for the keys' address, not the key ID. So a
  // made-up key ID holds back the fetch of a key the issuer has just started signing with.
  it("refuses a newly published key's token while the library waits after an unknown key ID, then accepts it", async () => {
    const documents = { [KEYS_URI]: jwks([{ kid: KID, key: ISSUER_KEY }]) };
    const { verify, fetched } = verifier(documents);
    await verify(token());
    await expect(
      verify(token({ header: { kid: "made-up" }, key: OTHER_KEY })),
    ).resolves.toEqual({ reason: "key" });

    documents[KEYS_URI] = jwks([
      { kid: KID, key: ISSUER_KEY },
      { kid: "key-2", key: OTHER_KEY },
    ]);
    const rotated = token({ header: { kid: "key-2" }, key: OTHER_KEY });
    vi.advanceTimersByTime(UNKNOWN_KEY_WAIT_MS - 1);
    await expect(verify(rotated)).resolves.toEqual({ reason: "key" });
    // A key it already holds verifies throughout.
    await expect(verify(token())).resolves.toEqual(PIPELINE);
    expect(fetched).toEqual([KEYS_URI, KEYS_URI]);

    vi.advanceTimersByTime(1);
    await expect(verify(rotated)).resolves.toEqual(PIPELINE);
    expect(fetched).toEqual([KEYS_URI, KEYS_URI, KEYS_URI]);
  });
});
