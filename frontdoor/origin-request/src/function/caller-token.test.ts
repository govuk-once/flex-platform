import { generateKeyPairSync, type KeyObject, verify } from "node:crypto";

import { DecryptCommand, type KMSClient } from "@aws-sdk/client-kms";
import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { assert, describe, expect, it, vi } from "vitest";

import {
  createCallerTokenSigner,
  createSigningKeyLoader,
  SIGNING_KEY_LEAD_MS,
  SIGNING_KEY_REFRESH_MS,
  SIGNING_KEY_RETRY_MS,
} from "./caller-token.ts";

const PARAMETER = "/flex/frontdoor/sandbox/caller-token-signing-key";

interface TestKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly signsFrom: number;
}

function testKey(kid: string, signsFrom = 0): TestKey {
  return { kid, signsFrom, ...generateKeyPairSync("ed25519") };
}

// SSM and KMS in the signing region: the parameter holds the keys, each "encrypted" as its kid, and
// KMS decrypts one only with the context key rotation made it with. While `down`, neither answers.
function fakeAws(keys: readonly TestKey[], down = { now: false }) {
  const calls: unknown[] = [];
  const send = vi.fn(
    (command: unknown, options?: { abortSignal?: unknown }) => {
      calls.push(command);
      expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
      if (down.now) return Promise.reject(new Error("unreachable"));
      if (command instanceof GetParameterCommand) {
        return Promise.resolve({
          Parameter: {
            Value: JSON.stringify({
              keys: keys.map(({ kid, signsFrom }) => ({
                kid,
                privateKey: Buffer.from(kid).toString("base64"),
                signsFrom,
              })),
            }),
          },
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
  const client = { send } as unknown as Pick<SSMClient, "send"> &
    Pick<KMSClient, "send">;
  const decrypts = () =>
    calls.filter((command) => command instanceof DecryptCommand).length;
  return { ssm: client, kms: client, call: send, calls, decrypts };
}

const KEY = testKey("20261106T120000Z");

describe("createSigningKeyLoader", () => {
  function loader(aws: ReturnType<typeof fakeAws>, now: () => number) {
    return createSigningKeyLoader({
      ssm: aws.ssm,
      kms: aws.kms,
      parameterName: PARAMETER,
      now,
    });
  }

  it("reads the keys, decrypting each as the key it was made as, each call bounded", async () => {
    const aws = fakeAws([KEY]);
    const loaded = await loader(aws, () => 0)();

    expect(loaded.kid).toBe(KEY.kid);
    const [read, decrypt] = aws.calls;
    assert.instanceOf(read, GetParameterCommand);
    expect(read.input).toEqual({ Name: PARAMETER });
    assert.instanceOf(decrypt, DecryptCommand);
    expect(decrypt.input).toEqual({
      CiphertextBlob: Buffer.from(KEY.kid),
      EncryptionContext: { purpose: "flex-caller-token", kid: KEY.kid },
    });
    expect(aws.calls).toHaveLength(2);
  });

  it("switches to the next key the moment it starts, with no read", async () => {
    const next = testKey("20261106T121500Z", 60);
    const aws = fakeAws([KEY, next]);
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
    const aws = fakeAws([KEY], down);
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
    const aws = fakeAws([], { now: true });
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
      signsFrom: 0,
    };
    const aws = fakeAws([rsa]);
    await expect(loader(aws, () => 0)()).rejects.toThrow(
      "The signing key is not an Ed25519 key",
    );
  });
});

describe("createCallerTokenSigner", () => {
  const NOW = Date.parse("2026-11-06T12:00:00Z");

  function decode(segment: string): unknown {
    return JSON.parse(Buffer.from(segment, "base64url").toString());
  }

  it("signs the caller's values with EdDSA, for a minute, for the gateways", async () => {
    const sign = createCallerTokenSigner({
      loadKey: () => Promise.resolve({ kid: KEY.kid, key: KEY.privateKey }),
      audience: "flex:sandbox:gateways",
      now: () => NOW,
    });
    const token = await sign({ pairwiseId: "pairwise-id", jti: "request-id" });
    const [header = "", payload = "", signature = ""] = token.split(".");

    expect(decode(header)).toEqual({ alg: "EdDSA", typ: "JWT", kid: KEY.kid });
    expect(decode(payload)).toEqual({
      pairwiseId: "pairwise-id",
      service: "app",
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
});
