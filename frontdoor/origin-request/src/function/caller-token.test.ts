import { generateKeyPairSync, type KeyObject, verify } from "node:crypto";

import { type DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { DecryptCommand, type KMSClient } from "@aws-sdk/client-kms";
import { assert, describe, expect, it, vi } from "vitest";

import {
  createCallerTokenSigner,
  createSigningKeyLoader,
  SIGNING_KEY_LEAD_MS,
  SIGNING_KEY_REFRESH_MS,
  SIGNING_KEY_RETRY_MS,
} from "./caller-token.ts";

const TABLE = "frontdoor-sandbox-caller-token-private-keys";

interface TestKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly activeFrom: number;
  readonly activeUntil?: number;
}

function testKey(kid: string, activeFrom = 0, activeUntil?: number): TestKey {
  return {
    kid,
    activeFrom,
    ...(activeUntil !== undefined && { activeUntil }),
    ...generateKeyPairSync("ed25519"),
  };
}

// The item key rotation writes for a key, its private key "encrypted" as its kid.
function itemOf({ kid, activeFrom, activeUntil }: TestKey) {
  return {
    keyId: { S: kid },
    privateKey: { B: new Uint8Array(Buffer.from(kid)) },
    activeFrom: { N: String(activeFrom) },
    ...(activeUntil !== undefined && {
      activeUntil: { N: String(activeUntil) },
    }),
  };
}

interface FakeAwsOptions {
  /** While true, neither answers. */
  readonly down?: { now: boolean };
  /** The table's items, in place of the keys'. */
  readonly items?: () => Record<string, unknown>[];
  readonly lastEvaluatedKey?: Record<string, unknown>;
}

// DynamoDB and KMS in the signing region: the table holds the keys, and KMS decrypts one only with
// the context key rotation made it with.
function fakeAws(keys: readonly TestKey[], options: FakeAwsOptions = {}) {
  const calls: unknown[] = [];
  const send = vi.fn(
    (command: unknown, sendOptions?: { abortSignal?: unknown }) => {
      calls.push(command);
      expect(sendOptions?.abortSignal).toBeInstanceOf(AbortSignal);
      if (options.down?.now === true) {
        return Promise.reject(new Error("unreachable"));
      }
      if (command instanceof ScanCommand) {
        return Promise.resolve({
          Items: options.items?.() ?? keys.map(itemOf),
          ...(options.lastEvaluatedKey !== undefined && {
            LastEvaluatedKey: options.lastEvaluatedKey,
          }),
        });
      }
      if (!(command instanceof DecryptCommand)) {
        return Promise.reject(new Error("unexpected command"));
      }
      const { CiphertextBlob, EncryptionContext } = command.input;
      const key = keys.find(
        ({ kid }) => Buffer.from(CiphertextBlob ?? []).toString() === kid,
      );
      if (
        key === undefined ||
        EncryptionContext?.purpose !== "flex-caller-token" ||
        EncryptionContext.kid !== key.kid
      ) {
        return Promise.reject(new Error("InvalidCiphertextException"));
      }
      return Promise.resolve({
        Plaintext: new Uint8Array(
          key.privateKey.export({ format: "der", type: "pkcs8" }),
        ),
      });
    },
  );
  // Each client's `send` is overloaded for every command; the loader sends two of them.
  const client = { send } as unknown as Pick<DynamoDBClient, "send"> &
    Pick<KMSClient, "send">;
  const decrypts = () =>
    calls.filter((command) => command instanceof DecryptCommand).length;
  return { dynamodb: client, kms: client, call: send, calls, decrypts };
}

const KEY = testKey("20261106T120000Z");

describe("createSigningKeyLoader", () => {
  function loader(aws: ReturnType<typeof fakeAws>, now: () => number) {
    return createSigningKeyLoader({
      dynamodb: aws.dynamodb,
      kms: aws.kms,
      tableName: TABLE,
      now,
    });
  }

  it("reads the keys, decrypting each as the key it was made as, each call bounded", async () => {
    const aws = fakeAws([KEY]);
    const loaded = await loader(aws, () => 0)();

    expect(loaded.kid).toBe(KEY.kid);
    const [read, decrypt] = aws.calls;
    assert.instanceOf(read, ScanCommand);
    expect(read.input).toEqual({ TableName: TABLE });
    assert.instanceOf(decrypt, DecryptCommand);
    expect(decrypt.input).toEqual({
      CiphertextBlob: new Uint8Array(Buffer.from(KEY.kid)),
      EncryptionContext: { purpose: "flex-caller-token", kid: KEY.kid },
    });
    expect(aws.calls).toHaveLength(2);
  });

  it("switches to the next key the moment it starts, with no read", async () => {
    const next = testKey("20261106T121500Z", 60);
    const aws = fakeAws([testKey(KEY.kid, 0, 60), next]);
    let now = 0;
    const load = loader(aws, () => now);

    expect((await load()).kid).toBe(KEY.kid);
    now = 59_999;
    expect((await load()).kid).toBe(KEY.kid);
    now = 60_000;
    expect((await load()).kid).toBe(next.kid);
    expect(aws.call).toHaveBeenCalledTimes(3);
  });

  it("leaves the next key until its last hour, then decrypts it", async () => {
    const start = 7 * 24 * 60 * 60 * 1000;
    const next = testKey("20261106T121500Z", start / 1000);
    const aws = fakeAws([KEY, next]);
    let now = 0;
    const load = loader(aws, () => now);

    await load();
    now = start - SIGNING_KEY_LEAD_MS - SIGNING_KEY_REFRESH_MS;
    await load();
    expect(aws.decrypts()).toBe(1);

    now = start - SIGNING_KEY_LEAD_MS;
    expect((await load()).kid).toBe(KEY.kid);
    expect(aws.decrypts()).toBe(2);

    now = start;
    expect((await load()).kid).toBe(next.kid);
    expect(aws.decrypts()).toBe(2);
  });

  it("neither decrypts nor signs with a key that has stopped, which the table still holds", async () => {
    const stopped = testKey("20261106T110000Z", 0, 60);
    const aws = fakeAws([stopped, testKey(KEY.kid, 60)]);
    const load = loader(aws, () => 61_000);

    expect((await load()).kid).toBe(KEY.kid);
    expect(aws.decrypts()).toBe(1);
  });

  it("stops signing with a key it holds once the key stops, though no key follows", async () => {
    const aws = fakeAws([testKey(KEY.kid, 0, 60)]);
    let now = 0;
    const load = loader(aws, () => now);
    await load();

    now = 60_000;
    await expect(load()).rejects.toThrow("No signing key has started");
  });

  it("reads the keys again every five minutes, decrypting only a key it doesn't hold", async () => {
    const keys = [KEY];
    const aws = fakeAws(keys);
    let now = 0;
    const load = loader(aws, () => now);

    await load();
    now = SIGNING_KEY_REFRESH_MS - 1;
    await load();
    expect(aws.call).toHaveBeenCalledTimes(2);

    keys.push(testKey("20261106T121500Z", 3600));
    now = SIGNING_KEY_REFRESH_MS;
    await load();
    expect(aws.call).toHaveBeenCalledTimes(4);
    expect(aws.decrypts()).toBe(2);
  });

  it("stops signing with a revoked key at the next read", async () => {
    const keys = [KEY];
    const aws = fakeAws(keys);
    let now = 0;
    const load = loader(aws, () => now);
    await load();

    const replacement = testKey("20261106T123000Z", 60);
    keys.splice(0, 1, replacement);
    now = SIGNING_KEY_REFRESH_MS;
    expect((await load()).kid).toBe(replacement.kid);
  });

  it("reads once for requests that arrive together", async () => {
    const aws = fakeAws([KEY]);
    const load = loader(aws, () => 0);
    await Promise.all([load(), load(), load()]);
    expect(aws.call).toHaveBeenCalledTimes(2);
  });

  it("goes on signing with the keys it has when a read fails, and tries again after a wait", async () => {
    const down = { now: false };
    const aws = fakeAws([KEY], { down });
    let now = 0;
    const load = loader(aws, () => now);
    await load();

    down.now = true;
    now = SIGNING_KEY_REFRESH_MS;
    expect((await load()).kid).toBe(KEY.kid);
    const failedCalls = aws.call.mock.calls.length;
    now += SIGNING_KEY_RETRY_MS - 1;
    await load();
    expect(aws.call).toHaveBeenCalledTimes(failedCalls);
    now += 1;
    await load();
    expect(aws.call.mock.calls.length).toBeGreaterThan(failedCalls);
  });

  it("fails with no key at all, and doesn't read again for every request", async () => {
    const aws = fakeAws([], { down: { now: true } });
    const load = loader(aws, () => 0);
    await expect(load()).rejects.toThrow("unreachable");
    const calls = aws.call.mock.calls.length;
    await expect(load()).rejects.toThrow(
      "No signing key: the last read failed",
    );
    expect(aws.call).toHaveBeenCalledTimes(calls);
  });

  it("fails when no key it holds has started", async () => {
    const aws = fakeAws([testKey("20261106T121500Z", 600)]);
    await expect(loader(aws, () => 0)()).rejects.toThrow(
      "No signing key has started",
    );
  });

  it("refuses a key that isn't Ed25519", async () => {
    const rsa = {
      ...generateKeyPairSync("rsa", { modulusLength: 2048 }),
      kid: KEY.kid,
      activeFrom: 0,
    };
    const aws = fakeAws([rsa]);
    await expect(loader(aws, () => 0)()).rejects.toThrow(
      "The signing key is not an Ed25519 key",
    );
  });

  it("refuses a table that needs more than one read, rather than sign from part of it", async () => {
    const aws = fakeAws([KEY], { lastEvaluatedKey: { keyId: { S: KEY.kid } } });
    await expect(loader(aws, () => 0)()).rejects.toThrow(
      "The private keys table answered with more than one page",
    );
    expect(aws.decrypts()).toBe(0);
  });

  it.each([
    ["a key ID that isn't one", { keyId: { S: "../x" } }],
    ["a private key that isn't binary", { privateKey: { S: "AQID" } }],
    ["a start that isn't a number", { activeFrom: { S: "0" } }],
    ["a start that isn't a whole second", { activeFrom: { N: "1.5" } }],
    ["an end before the start", { activeUntil: { N: "0" } }],
    ["an end that isn't a number", { activeUntil: { S: "60" } }],
  ])(
    "refuses the whole table for %s, decrypting nothing",
    async (_, fields) => {
      const aws = fakeAws([KEY], {
        items: () => [
          itemOf(testKey("20261106T110000Z")),
          { ...itemOf(KEY), ...fields },
        ],
      });
      await expect(loader(aws, () => 0)()).rejects.toThrow(
        "The private keys table holds something that isn't a key",
      );
      expect(aws.decrypts()).toBe(0);
    },
  );
});

describe("createCallerTokenSigner", () => {
  const NOW = Date.parse("2026-11-06T12:00:00Z");

  function decode(segment: string): unknown {
    return JSON.parse(Buffer.from(segment, "base64url").toString());
  }

  const loadKey = () => Promise.resolve({ kid: KEY.kid, key: KEY.privateKey });

  it("signs the caller's values with EdDSA, for a minute, for the gateways", async () => {
    const derivePushId = vi.fn((pairwiseId: string) =>
      Promise.resolve(`push-id-of-${pairwiseId}`),
    );
    const sign = createCallerTokenSigner({
      loadKey,
      derivePushId,
      audience: "flex:sandbox:gateways",
      now: () => NOW,
    });
    const token = await sign({ pairwiseId: "pairwise-id", jti: "request-id" });
    const [header = "", payload = "", signature = ""] = token.split(".");

    expect(decode(header)).toEqual({ alg: "EdDSA", typ: "JWT", kid: KEY.kid });
    expect(decode(payload)).toEqual({
      pairwiseId: "pairwise-id",
      service: "app",
      pushId: "push-id-of-pairwise-id",
      aud: "flex:sandbox:gateways",
      iat: NOW / 1000,
      exp: NOW / 1000 + 60,
      jti: "request-id",
    });
    expect(
      verify(
        null,
        Buffer.from(`${header}.${payload}`),
        KEY.publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("signs nothing without the caller's push ID", async () => {
    const sign = createCallerTokenSigner({
      loadKey,
      derivePushId: () => Promise.reject(new Error("no push ID secret")),
      audience: "flex:sandbox:gateways",
      now: () => NOW,
    });
    await expect(
      sign({ pairwiseId: "pairwise-id", jti: "request-id" }),
    ).rejects.toThrow("no push ID secret");
  });

  it("signs nothing without a key, though it has the push ID", async () => {
    const sign = createCallerTokenSigner({
      loadKey: () => Promise.reject(new Error("no signing key")),
      derivePushId: () => Promise.resolve("push-id"),
      audience: "flex:sandbox:gateways",
      now: () => NOW,
    });
    await expect(
      sign({ pairwiseId: "pairwise-id", jti: "request-id" }),
    ).rejects.toThrow("no signing key");
  });
});
