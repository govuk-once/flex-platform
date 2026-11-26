import type { KeyObject } from "node:crypto";
import { generateKeyPairSync, sign } from "node:crypto";

import { ScanCommand } from "@aws-sdk/client-dynamodb";
import { afterEach, assert, describe, expect, it, vi } from "vitest";

import {
  createCallerTokenKeys,
  createCallerTokenVerifier,
  type KeyItem,
  KEYS_MAX_AGE_MS,
  KEYS_MAX_STALE_MS,
  KEYS_MIN_INTERVAL_MS,
  readCallerTokenVerifier,
  scanKeyTable,
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
      pushId: "SYNTHETIC_PUSH_ID",
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

const der = (key: KeyObject) =>
  new Uint8Array(key.export({ format: "der", type: "spki" }));

// A key's item as key rotation writes it. A key signs from FROM, with no end, unless it says.
function keyItem(kid: string, key: KeyObject, window: Window = {}): KeyItem {
  const signsFrom = Object.hasOwn(window, "signsFrom")
    ? window.signsFrom
    : FROM;
  return {
    keyId: { S: kid },
    publicKey: { B: der(key) },
    ...(signsFrom !== undefined && { activeFrom: { N: String(signsFrom) } }),
    ...(window.signsUntil !== undefined && {
      activeUntil: { N: String(window.signsUntil) },
    }),
  };
}

const keyItems = (keys: Record<string, KeyObject>, window: Window = {}) =>
  Object.entries(keys).map(([kid, key]) => keyItem(kid, key, window));

function verifier(now = () => NOW, window: Window = {}) {
  return createCallerTokenVerifier({
    audience: AUDIENCE,
    keys: createCallerTokenKeys({
      read: () =>
        Promise.resolve(keyItems({ [KID]: SIGNING.publicKey }, window)),
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
      claims: {
        pairwiseId: "SYNTHETIC_PAIRWISE_ID",
        service: "app",
        pushId: "SYNTHETIC_PUSH_ID",
      },
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
      "without a push ID",
      () => token({ payload: { pushId: undefined } }),
      "claim pushId",
    ],
    [
      "with an empty push ID",
      () => token({ payload: { pushId: "" } }),
      "claim pushId",
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
      Promise.resolve(keyItems({ [KID]: SIGNING.publicKey })),
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
    let set = keyItems({ [KID]: SIGNING.publicKey });
    const read = vi.fn(() => Promise.resolve(set));
    const keys = createCallerTokenKeys({ read, now: () => now });
    await keys.get(KID);

    set = keyItems({ [KID]: SIGNING.publicKey, [OTHER_KID]: OTHER.publicKey });
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
        : Promise.resolve(keyItems({ [KID]: SIGNING.publicKey })),
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

  const item = (fields: Record<string, unknown>) => [fields as KeyItem];

  it.each([
    ["can't be read", () => Promise.reject(new Error("SYNTHETIC store error"))],
    [
      "hold an item without a key ID",
      () => Promise.resolve(item({ publicKey: { B: der(SIGNING.publicKey) } })),
    ],
    [
      "hold an item whose key ID is of another shape",
      () => Promise.resolve(keyItems({ "../keys": SIGNING.publicKey })),
    ],
    [
      "hold an item that is neither a key, a revoked key nor the version",
      () => Promise.resolve(item({ keyId: { S: KID } })),
    ],
    [
      "hold a key that isn't Ed25519",
      () =>
        Promise.resolve(
          keyItems({ [KID]: generateKeyPairSync("ed448").publicKey }),
        ),
    ],
    [
      "hold a key that isn't a public key at all",
      () =>
        Promise.resolve(
          item({
            keyId: { S: KID },
            publicKey: { B: new Uint8Array(32) },
            activeFrom: { N: String(FROM) },
          }),
        ),
    ],
    [
      "hold a key without the time it starts",
      () =>
        Promise.resolve(
          keyItems({ [KID]: SIGNING.publicKey }, { signsFrom: undefined }),
        ),
    ],
    [
      "hold a key that stops before it starts",
      () =>
        Promise.resolve(
          keyItems({ [KID]: SIGNING.publicKey }, { signsUntil: FROM }),
        ),
    ],
    [
      "hold a key whose start isn't whole seconds",
      () =>
        Promise.resolve(
          keyItems({ [KID]: SIGNING.publicKey }, { signsFrom: FROM + 0.5 }),
        ),
    ],
    [
      "hold a key whose end isn't whole seconds",
      () =>
        Promise.resolve(
          keyItems({ [KID]: SIGNING.publicKey }, { signsUntil: FROM + 60.5 }),
        ),
    ],
    [
      "hold a key whose time is text",
      () =>
        Promise.resolve(
          item({
            keyId: { S: KID },
            publicKey: { B: der(SIGNING.publicKey) },
            activeFrom: { S: String(FROM) },
          }),
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

  it("gives a key that has stopped, with the time it stopped", async () => {
    const until = FROM + 3600;
    const keys = createCallerTokenKeys({
      read: () =>
        Promise.resolve(
          keyItems({ [KID]: SIGNING.publicKey }, { signsUntil: until }),
        ),
    });
    expect(await keys.get(KID)).toMatchObject({
      signsFrom: FROM,
      signsUntil: until,
    });
  });

  it("passes over a revoked key's record and the version item", async () => {
    const keys = createCallerTokenKeys({
      read: () =>
        Promise.resolve([
          ...keyItems({ [KID]: SIGNING.publicKey }),
          { keyId: { S: OTHER_KID }, revokedAt: { N: String(FROM) } },
          { keyId: { S: "#version" }, version: { N: "3" } },
        ]),
    });
    expect(await keys.get(KID)).toBeDefined();
    expect(await keys.get(OTHER_KID)).toBeUndefined();
  });

  it("reads once for calls that arrive together", async () => {
    const read = vi.fn(() =>
      Promise.resolve(keyItems({ [KID]: SIGNING.publicKey })),
    );
    const keys = createCallerTokenKeys({ read });
    await Promise.all([keys.get(KID), keys.get(KID), keys.get(KID)]);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("scanKeyTable", () => {
  const TABLE =
    "arn:aws:dynamodb:eu-west-2:100000000002:table/frontdoor-sandbox-caller-token-public-keys";

  // DynamoDB, answering a scan with one page.
  function client(page: { Items?: KeyItem[]; LastEvaluatedKey?: KeyItem }) {
    const sent: unknown[] = [];
    return {
      sent,
      send: vi.fn((command: unknown) => {
        assert.instanceOf(command, ScanCommand);
        sent.push(command.input);
        return Promise.resolve(page);
      }),
    };
  }

  it("reads the table whole, named by its ARN, in one call", async () => {
    const items = keyItems({ [KID]: SIGNING.publicKey });
    const dynamodb = client({ Items: items });
    expect(await scanKeyTable(dynamodb, TABLE)()).toEqual(items);
    expect(dynamodb.sent).toEqual([{ TableName: TABLE }]);
  });

  it("refuses a table that needs a second page", async () => {
    const dynamodb = client({
      Items: keyItems({ [KID]: SIGNING.publicKey }),
      LastEvaluatedKey: { keyId: { S: KID } },
    });
    await expect(scanKeyTable(dynamodb, TABLE)()).rejects.toThrow(
      "the table answered with more than one page",
    );
    expect(dynamodb.send).toHaveBeenCalledTimes(1);
  });

  it("refuses an answer with no items", async () => {
    await expect(scanKeyTable(client({}), TABLE)()).rejects.toThrow(
      "the table answered with more than one page",
    );
  });
});

describe("readCallerTokenVerifier", () => {
  const DEPLOYED = {
    AWS_REGION: "eu-west-2",
    FLEX_CALLER_TOKEN_KEYS_TABLE:
      "arn:aws:dynamodb:eu-west-2:100000000002:table/frontdoor-sandbox-caller-token-public-keys",
    FLEX_CALLER_TOKEN_KEYS_ENDPOINT:
      "vpce-0123456789abcdef0-abcdefgh.dynamodb.eu-west-2.vpce.amazonaws.com",
    FLEX_CALLER_TOKEN_AUDIENCE: AUDIENCE,
  };

  it("starts with the deployment's variables", () => {
    expect(() => readCallerTokenVerifier(DEPLOYED)).not.toThrow();
  });

  it.each([
    "FLEX_CALLER_TOKEN_KEYS_TABLE",
    "FLEX_CALLER_TOKEN_KEYS_ENDPOINT",
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

  it.each([
    "frontdoor-sandbox-caller-token-public-keys",
    "arn:aws:s3:::frontdoor-sandbox-keys-100000000002",
    "arn:aws:dynamodb:eu-west-2:frontdoor:table/frontdoor-sandbox-caller-token-public-keys",
  ])("refuses to start with a table that isn't named by its ARN: %s", (arn) => {
    expect(() =>
      readCallerTokenVerifier({
        ...DEPLOYED,
        FLEX_CALLER_TOKEN_KEYS_TABLE: arn,
      }),
    ).toThrow(
      "Environment variable FLEX_CALLER_TOKEN_KEYS_TABLE must be a DynamoDB table's ARN",
    );
  });

  it("refuses to start with a table in another region than its own", () => {
    expect(() =>
      readCallerTokenVerifier({
        ...DEPLOYED,
        FLEX_CALLER_TOKEN_KEYS_TABLE:
          "arn:aws:dynamodb:us-east-1:100000000002:table/frontdoor-sandbox-caller-token-public-keys",
      }),
    ).toThrow(
      "Environment variable FLEX_CALLER_TOKEN_KEYS_TABLE must name a table in eu-west-2",
    );
  });

  it.each([
    "https://vpce-0123456789abcdef0-abcdefgh.dynamodb.eu-west-2.vpce.amazonaws.com",
    "http://localhost",
    "vpce-0123456789abcdef0-abcdefgh.dynamodb.eu-west-2.vpce.amazonaws.com:443",
    "vpce-0123456789abcdef0-abcdefgh.dynamodb.eu-west-2.vpce.amazonaws.com/keys",
    "127.0.0.1",
    "localhost",
  ])("refuses to start with an endpoint that isn't a name alone: %s", (url) => {
    expect(() =>
      readCallerTokenVerifier({
        ...DEPLOYED,
        FLEX_CALLER_TOKEN_KEYS_ENDPOINT: url,
      }),
    ).toThrow(
      "Environment variable FLEX_CALLER_TOKEN_KEYS_ENDPOINT must be an endpoint's name",
    );
  });
});
