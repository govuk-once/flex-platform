import { generateKeyPairSync, type KeyObject, verify } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { AwsJsonCall, AwsJsonRequest } from "./aws-json.ts";
import {
  createCallerTokenSigner,
  createSigningKeyLoader,
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
// KMS decrypts one only with the context key rotation made it with. Any other region, or the
// signing region while it is down, can't be reached.
function fakeAws(keys: readonly TestKey[], down = { now: false }) {
  const calls: AwsJsonRequest[] = [];
  const call = vi.fn<AwsJsonCall>((request) => {
    calls.push(request);
    if (down.now || request.region !== "eu-west-2") {
      return Promise.reject(new Error("unreachable"));
    }
    if (request.target === "AmazonSSM.GetParameter") {
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
    const body = request.body as {
      CiphertextBlob: string;
      EncryptionContext: Record<string, string>;
    };
    const key = keys.find(
      ({ kid }) => body.CiphertextBlob === Buffer.from(kid).toString("base64"),
    );
    if (
      key === undefined ||
      body.EncryptionContext.purpose !== "flex-caller-token" ||
      body.EncryptionContext.kid !== key.kid
    ) {
      return Promise.reject(new Error("InvalidCiphertextException"));
    }
    return Promise.resolve({
      Plaintext: key.privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64"),
    });
  });
  const decrypts = () =>
    calls.filter(({ target }) => target === "TrentService.Decrypt").length;
  return { call, calls, decrypts };
}

const KEY = testKey("20261106T120000Z");

describe("createSigningKeyLoader", () => {
  function loader(aws: ReturnType<typeof fakeAws>, now: () => number) {
    return createSigningKeyLoader({
      call: aws.call,
      parameterName: PARAMETER,
      region: "eu-west-2",
      now,
    });
  }

  it("reads the signing region's keys, decrypting each there as the key it was made as", async () => {
    const aws = fakeAws([KEY]);
    const loaded = await loader(aws, () => 0)();

    expect(loaded.kid).toBe(KEY.kid);
    expect(aws.calls).toEqual([
      {
        service: "ssm",
        region: "eu-west-2",
        target: "AmazonSSM.GetParameter",
        body: { Name: PARAMETER },
      },
      {
        service: "kms",
        region: "eu-west-2",
        target: "TrentService.Decrypt",
        body: {
          CiphertextBlob: Buffer.from(KEY.kid).toString("base64"),
          EncryptionContext: { purpose: "flex-caller-token", kid: KEY.kid },
        },
      },
    ]);
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
