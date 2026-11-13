import type { KeyObject } from "node:crypto";
import { generateKeyPairSync, sign } from "node:crypto";

import { afterEach, assert, describe, expect, it, vi } from "vitest";

import {
  createCallerTokenKeys,
  createCallerTokenVerifier,
  KEYS_MAX_AGE_MS,
  KEYS_MAX_STALE_MS,
  KEYS_MIN_INTERVAL_MS,
  readCallerTokenVerifier,
} from "./caller-token.ts";
import { GatewayError } from "./errors.ts";

const KID = "20261106T120000Z";
const OTHER_KID = "20261106T121500Z";
const AUDIENCE = "flex:sandbox:gateways";
const NOW = Date.parse("2026-11-06T12:30:00Z");
const IAT = NOW / 1000;
// When KID started to sign.
const FROM = Date.parse("2026-11-06T12:00:00Z") / 1000;

const SIGNING = generateKeyPairSync("ed25519");
const OTHER = generateKeyPairSync("ed25519");

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

interface TokenParts {
  readonly header?: Record<string, unknown>;
  readonly payload?: Record<string, unknown>;
  readonly key?: KeyObject;
}

// A token as the edge signs it, with any part replaced.
function token({ header, payload, key }: TokenParts = {}): string {
  const input = `${b64({ alg: "EdDSA", typ: "JWT", kid: KID, ...header })}.${b64(
    {
      pairwiseId: "SYNTHETIC_PAIRWISE_ID",
      service: "app",
      aud: AUDIENCE,
      iat: IAT,
      exp: IAT + 60,
      jti: "SYNTHETIC_REQUEST_ID",
      ...payload,
    },
  )}`;
  const signature = sign(null, Buffer.from(input), key ?? SIGNING.privateKey);
  return `${input}.${signature.toString("base64url")}`;
}

// A token signed over a payload that isn't JSON, which `token` can't make.
function signedText(payload: string): string {
  const input = `${b64({ alg: "EdDSA", kid: KID })}.${Buffer.from(payload).toString("base64url")}`;
  const signature = sign(null, Buffer.from(input), SIGNING.privateKey);
  return `${input}.${signature.toString("base64url")}`;
}

interface Window {
  // Undefined leaves the key without the time.
  readonly signsFrom?: number | undefined;
  readonly signsUntil?: number;
}

// A JWK set as key rotation writes it. A key signs from FROM, with no end, unless it says.
const keySet = (keys: Record<string, KeyObject>, windows: Window = {}) =>
  JSON.stringify({
    keys: Object.entries(keys).map(([kid, key]) => ({
      kty: "OKP",
      crv: "Ed25519",
      alg: "EdDSA",
      use: "sig",
      kid,
      x: key.export({ format: "jwk" }).x,
      signsFrom: FROM,
      ...windows,
    })),
  });

function verifier(now = () => NOW, window: Window = {}) {
  return createCallerTokenVerifier({
    audience: AUDIENCE,
    keys: createCallerTokenKeys({
      read: () => Promise.resolve(keySet({ [KID]: SIGNING.publicKey }, window)),
      now,
    }),
    now,
  });
}

async function refusal(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    assert.instanceOf(error, GatewayError);
    return error;
  }
  throw new Error("expected the token to be refused");
}

describe("createCallerTokenVerifier", () => {
  it("accepts a token the edge signed, giving its claims and ID", async () => {
    await expect(verifier()(token())).resolves.toEqual({
      claims: { pairwiseId: "SYNTHETIC_PAIRWISE_ID", service: "app" },
      tokenId: "SYNTHETIC_REQUEST_ID",
    });
  });

  it("refuses a call without a token as UNAUTHENTICATED", async () => {
    for (const missing of [undefined, ""]) {
      const error = await refusal(verifier()(missing));
      expect(error.code).toBe("UNAUTHENTICATED");
    }
  });

  it.each<[string, () => string, string]>([
    [
      "signed with another key",
      () => token({ key: OTHER.privateKey }),
      "signature",
    ],
    [
      "with its claims changed after signing",
      () => {
        const [header, , signature] = token().split(".");
        return `${header}.${b64({ pairwiseId: "SYNTHETIC_OTHER", aud: AUDIENCE, iat: IAT, exp: IAT + 60, jti: "x" })}.${signature}`;
      },
      "signature",
    ],
    [
      "with an unknown key ID",
      () => token({ header: { kid: OTHER_KID } }),
      "unknown key",
    ],
    [
      "with a key ID of another shape",
      () => token({ header: { kid: "../keys" } }),
      "key ID",
    ],
    [
      "for another algorithm",
      () => token({ header: { alg: "HS256" } }),
      "algorithm",
    ],
    [
      "with no algorithm",
      () => token({ header: { alg: undefined } }),
      "algorithm",
    ],
    [
      "with a critical header",
      () => token({ header: { crit: ["exp"] } }),
      "critical header",
    ],
    [
      "for another audience",
      () => token({ payload: { aud: "flex:production:gateways" } }),
      "audience",
    ],
    [
      "expired",
      () => token({ payload: { iat: IAT - 120, exp: IAT - 60 } }),
      "expired",
    ],
    [
      "issued in the future",
      () => token({ payload: { iat: IAT + 30, exp: IAT + 90 } }),
      "issued later",
    ],
    [
      "living longer than the edge signs for",
      () => token({ payload: { exp: IAT + 3600 } }),
      "lifetime",
    ],
    ["without times", () => token({ payload: { iat: "now" } }), "times"],
    [
      "without a pairwise ID",
      () => token({ payload: { pairwiseId: "" } }),
      "claim pairwiseId",
    ],
    [
      "with a pairwise ID that isn't a string",
      () => token({ payload: { pairwiseId: 7 } }),
      "claim pairwiseId",
    ],
    [
      "without a service",
      () => token({ payload: { service: undefined } }),
      "claim service",
    ],
    [
      "with a token ID that isn't CloudFront's",
      () => token({ payload: { jti: "a b" } }),
      "token ID",
    ],
    [
      "of two parts",
      () => token().split(".").slice(0, 2).join("."),
      "not a compact JWS",
    ],
    ["in a second encoding", () => `${token()}=`, "signature"],
    ["far too long", () => "a".repeat(5000), "too long"],
    [
      "that isn't JSON",
      () => `${Buffer.from("x").toString("base64url")}.e30.e30`,
      "header",
    ],
    ["without a key ID", () => token({ header: { kid: undefined } }), "key ID"],
    [
      "with a signature of the wrong length",
      () => {
        const [header, payload] = token().split(".");
        return `${header}.${payload}.${Buffer.alloc(32).toString("base64url")}`;
      },
      "signature",
    ],
    [
      "with a signed payload that isn't JSON",
      () => signedText("SYNTHETIC"),
      "payload",
    ],
    [
      "with an expiry that isn't a number",
      () => token({ payload: { exp: String(IAT + 60) } }),
      "times",
    ],
  ])("refuses a token %s, naming the check alone", async (_, make, check) => {
    const error = await refusal(verifier()(make()));
    expect(error.code).toBe("SECURE_SIGNATURE_INVALID");
    expect(error.message).toBe(`Caller token refused: ${check}`);
    expect(error.message).not.toContain("SYNTHETIC");
  });

  it("allows the edge's clock a few seconds either way", async () => {
    await expect(verifier(() => NOW + 63_000)(token())).resolves.toBeDefined();
    await expect(verifier(() => NOW - 4_000)(token())).resolves.toBeDefined();
  });

  it("refuses a token at the moment its expiry passes the tolerance", async () => {
    const error = await refusal(verifier(() => NOW + 65_000)(token()));
    expect(error.message).toBe("Caller token refused: expired");
  });

  it("allows the key's times the same tolerance as the clock", async () => {
    await expect(
      verifier(() => NOW, { signsFrom: IAT + 5 })(token()),
    ).resolves.toBeDefined();
    await expect(
      verifier(() => NOW, { signsUntil: IAT - 5 })(token()),
    ).resolves.toBeDefined();
  });

  it("refuses a token issued before its key started to sign", async () => {
    const error = await refusal(
      verifier(() => NOW, { signsFrom: IAT + 10 })(token()),
    );
    expect(error.message).toBe("Caller token refused: key not yet signing");
  });

  it("accepts a token issued just before its key was replaced, for the rest of its life", async () => {
    const replaced = { signsUntil: IAT + 1 };
    await expect(
      verifier(() => NOW + 64_000, replaced)(token()),
    ).resolves.toBeDefined();
  });

  it("refuses a token issued after its key was replaced, however it is timed", async () => {
    const error = await refusal(
      verifier(() => NOW, { signsUntil: IAT - 6 })(token()),
    );
    expect(error.message).toBe("Caller token refused: key replaced");
  });

  it("reads only the claims a token holds, never the prototype's", async () => {
    const error = await refusal(
      verifier()(token({ payload: { pairwiseId: undefined } })),
    );
    expect(error.message).toBe("Caller token refused: claim pairwiseId");
  });
});

describe("createCallerTokenKeys", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the keys once, and again after a minute", async () => {
    let now = 0;
    const read = vi.fn(() =>
      Promise.resolve(keySet({ [KID]: SIGNING.publicKey })),
    );
    const keys = createCallerTokenKeys({ read, now: () => now });

    await keys.get(KID);
    now = KEYS_MAX_AGE_MS - 1;
    await keys.get(KID);
    expect(read).toHaveBeenCalledTimes(1);
    now = KEYS_MAX_AGE_MS;
    await keys.get(KID);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads again for a key ID it doesn't hold, but not more than once in ten seconds", async () => {
    let now = 0;
    let set = keySet({ [KID]: SIGNING.publicKey });
    const read = vi.fn(() => Promise.resolve(set));
    const keys = createCallerTokenKeys({ read, now: () => now });
    await keys.get(KID);

    set = keySet({ [KID]: SIGNING.publicKey, [OTHER_KID]: OTHER.publicKey });
    now = KEYS_MIN_INTERVAL_MS - 1;
    expect(await keys.get(OTHER_KID)).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    now = KEYS_MIN_INTERVAL_MS;
    expect(await keys.get(OTHER_KID)).toBeDefined();
    expect(read).toHaveBeenCalledTimes(2);
  });

  // Keys read at 0 that the store then can't give again.
  function failingAfterFirstRead() {
    const clock = { now: 0 };
    let fail = false;
    const read = vi.fn(() =>
      fail
        ? Promise.reject(new Error("SYNTHETIC store error"))
        : Promise.resolve(keySet({ [KID]: SIGNING.publicKey })),
    );
    const keys = createCallerTokenKeys({ read, now: () => clock.now });
    return {
      clock,
      read,
      keys,
      async start() {
        await keys.get(KID);
        fail = true;
      },
      recover() {
        fail = false;
      },
    };
  }

  it("keeps the keys it has when a read fails, and tries again ten seconds later", async () => {
    const store = failingAfterFirstRead();
    await store.start();

    store.clock.now = KEYS_MAX_AGE_MS;
    expect(await store.keys.get(KID)).toBeDefined();
    expect(store.read).toHaveBeenCalledTimes(2);
    store.clock.now += KEYS_MIN_INTERVAL_MS - 1;
    await store.keys.get(KID);
    expect(store.read).toHaveBeenCalledTimes(2);
    store.clock.now += 1;
    await store.keys.get(KID);
    expect(store.read).toHaveBeenCalledTimes(3);
  });

  it("refuses every token once five minutes pass without a read that worked, and goes on when one does", async () => {
    const store = failingAfterFirstRead();
    await store.start();

    store.clock.now = KEYS_MAX_STALE_MS - 1;
    expect(await store.keys.get(KID)).toBeDefined();
    store.clock.now = KEYS_MAX_STALE_MS;
    const error = await refusal(store.keys.get(KID));
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toBe("The caller token's keys could not be read");

    store.recover();
    store.clock.now += KEYS_MIN_INTERVAL_MS;
    expect(await store.keys.get(KID)).toBeDefined();
  });

  it("refuses a token when a read that fails ends after the five minutes, though it started before", async () => {
    const store = failingAfterFirstRead();
    await store.start();
    store.read.mockImplementationOnce(() => {
      store.clock.now = KEYS_MAX_STALE_MS;
      return Promise.reject(new Error("SYNTHETIC store error"));
    });

    store.clock.now = KEYS_MAX_STALE_MS - 1;
    const error = await refusal(store.keys.get(KID));
    expect(error.code).toBe("INTERNAL");
    expect(store.read).toHaveBeenCalledTimes(2);
  });

  it("doesn't read again for every call while it has no keys", async () => {
    const read = vi.fn(() =>
      Promise.reject(new Error("SYNTHETIC store error")),
    );
    const keys = createCallerTokenKeys({ read, now: () => 0 });
    await refusal(keys.get(KID));
    await refusal(keys.get(KID));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["can't be read", () => Promise.reject(new Error("SYNTHETIC store error"))],
    ["aren't a JWK set", () => Promise.resolve('{"SYNTHETIC":1}')],
    [
      "hold a key that isn't Ed25519",
      () =>
        Promise.resolve(
          JSON.stringify({
            keys: [{ kty: "RSA", kid: KID, n: "x", e: "AQAB" }],
          }),
        ),
    ],
    [
      "hold a key without the time it starts",
      () =>
        Promise.resolve(
          keySet({ [KID]: SIGNING.publicKey }, { signsFrom: undefined }),
        ),
    ],
    [
      "hold a key that stops before it starts",
      () =>
        Promise.resolve(
          keySet({ [KID]: SIGNING.publicKey }, { signsUntil: FROM }),
        ),
    ],
    [
      "hold a key that isn't an object",
      () => Promise.resolve(JSON.stringify({ keys: ["SYNTHETIC"] })),
    ],
    [
      "hold a key with a key ID of another shape",
      () => Promise.resolve(keySet({ "../keys": SIGNING.publicKey })),
    ],
    [
      "hold a key of the wrong length",
      () =>
        Promise.resolve(
          JSON.stringify({
            keys: [
              {
                kty: "OKP",
                crv: "Ed25519",
                kid: KID,
                x: Buffer.alloc(16).toString("base64url"),
                signsFrom: FROM,
              },
            ],
          }),
        ),
    ],
    [
      "hold a key whose start isn't whole seconds",
      () =>
        Promise.resolve(
          keySet({ [KID]: SIGNING.publicKey }, { signsFrom: FROM + 0.5 }),
        ),
    ],
    [
      "hold a key whose end isn't whole seconds",
      () =>
        Promise.resolve(
          keySet({ [KID]: SIGNING.publicKey }, { signsUntil: FROM + 60.5 }),
        ),
    ],
  ])(
    "fails as INTERNAL, saying nothing of why, when the keys %s",
    async (_, read) => {
      const error = await refusal(createCallerTokenKeys({ read }).get(KID));
      expect(error.code).toBe("INTERNAL");
      expect(error.message).toBe("The caller token's keys could not be read");
    },
  );

  it("reads once for calls that arrive together", async () => {
    const read = vi.fn(() =>
      Promise.resolve(keySet({ [KID]: SIGNING.publicKey })),
    );
    const keys = createCallerTokenKeys({ read });
    await Promise.all([keys.get(KID), keys.get(KID), keys.get(KID)]);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("readCallerTokenVerifier", () => {
  const DEPLOYED = {
    AWS_REGION: "eu-west-2",
    FLEX_CALLER_TOKEN_KEYS_BUCKET: "frontdoor-sandbox-keys-100000000002",
    FLEX_CALLER_TOKEN_KEYS_OBJECT: "caller-token-keys.json",
    FLEX_CALLER_TOKEN_KEYS_ACCOUNT: "100000000002",
    FLEX_CALLER_TOKEN_AUDIENCE: AUDIENCE,
  };

  it.each([
    "FLEX_CALLER_TOKEN_KEYS_BUCKET",
    "FLEX_CALLER_TOKEN_KEYS_OBJECT",
    "FLEX_CALLER_TOKEN_KEYS_ACCOUNT",
    "FLEX_CALLER_TOKEN_AUDIENCE",
  ])("refuses to start without %s", (name) => {
    const env: Record<string, string> = { ...DEPLOYED };
    delete env[name];
    expect(() => readCallerTokenVerifier(env)).toThrow(
      `Environment variable ${name} must be set`,
    );
  });

  it("refuses to start with a variable that is only whitespace", () => {
    expect(() =>
      readCallerTokenVerifier({
        ...DEPLOYED,
        FLEX_CALLER_TOKEN_AUDIENCE: "  ",
      }),
    ).toThrow("Environment variable FLEX_CALLER_TOKEN_AUDIENCE must be set");
  });

  it("refuses to start with a bucket owner that isn't an account ID", () => {
    expect(() =>
      readCallerTokenVerifier({
        ...DEPLOYED,
        FLEX_CALLER_TOKEN_KEYS_ACCOUNT: "frontdoor",
      }),
    ).toThrow(
      "Environment variable FLEX_CALLER_TOKEN_KEYS_ACCOUNT must be an AWS account ID",
    );
  });
});
