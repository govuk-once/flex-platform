import {
  GetSecretValueCommand,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createPushIdDeriver,
  PUSH_ID_SECRET_RETRY_MS,
  pushIdFor,
} from "./push-id.ts";

const SECRET_ID = "frontdoor-sandbox-push-id-secret";
const SECRET = "SYNTHETIC_PUSH_ID_SECRET";

// HMAC-SHA256 of "pairwise-id" under SECRET, base64url, as OpenSSL computes it:
//   printf 'pairwise-id' | openssl dgst -sha256 -hmac SYNTHETIC_PUSH_ID_SECRET -binary
// A user's push ID must never change, so this value must never change either.
const PUSH_ID = "ZbyXHpWT-qInzRRvPWestnbSOSiXPtrg8cxiutaCFLQ";

// Secrets Manager in the signing region, answering with whatever `stored.value` is. While `down`,
// it doesn't answer.
function fakeSecrets(
  stored: { value: string | undefined } = { value: SECRET },
  down = { now: false },
) {
  const calls: unknown[] = [];
  const send = vi.fn(
    (command: unknown, options?: { abortSignal?: unknown }) => {
      calls.push(command);
      expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
      if (down.now) return Promise.reject(new Error("unreachable"));
      return Promise.resolve({ SecretString: stored.value });
    },
  );
  // The client's `send` is overloaded for every command; the deriver sends one of them.
  const secrets = { send } as unknown as Pick<SecretsManagerClient, "send">;
  return { secrets, call: send, calls };
}

function deriver(aws: ReturnType<typeof fakeSecrets>) {
  return createPushIdDeriver({ secrets: aws.secrets, secretId: SECRET_ID });
}

describe("pushIdFor", () => {
  it("is the HMAC-SHA256 of the pairwise ID under the secret, as base64url", () => {
    expect(pushIdFor("pairwise-id", SECRET)).toBe(PUSH_ID);
  });

  it("keys with the whole secret as it is stored, never parsed or trimmed", () => {
    const json = `{"value":"${SECRET}"}`;
    const ids = [SECRET, ` ${SECRET}`, `${SECRET}\n`, json].map((secret) =>
      pushIdFor("pairwise-id", secret),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives each user an ID of their own", () => {
    expect(pushIdFor("another-pairwise-id", SECRET)).not.toBe(PUSH_ID);
  });
});

describe("createPushIdDeriver", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the secret by its name, the call bounded, and derives with it", async () => {
    const aws = fakeSecrets();

    expect(await deriver(aws)("pairwise-id")).toBe(PUSH_ID);
    const [read] = aws.calls;
    assert.instanceOf(read, GetSecretValueCommand);
    expect(read.input).toEqual({ SecretId: SECRET_ID });
    expect(aws.calls).toHaveLength(1);
  });

  it("reads the secret once, and keeps it for as long as the copy runs", async () => {
    const down = { now: false };
    const aws = fakeSecrets({ value: SECRET }, down);
    const derive = deriver(aws);
    await derive("pairwise-id");

    down.now = true;
    vi.setSystemTime(7 * 24 * 60 * 60 * 1000);
    expect(await derive("pairwise-id")).toBe(PUSH_ID);
    expect(aws.call).toHaveBeenCalledTimes(1);
  });

  it("reads once for requests that arrive together", async () => {
    const aws = fakeSecrets();
    const derive = deriver(aws);
    await Promise.all([derive("a"), derive("b"), derive("c")]);
    expect(aws.call).toHaveBeenCalledTimes(1);
  });

  it("fails while the secret can't be read, without reading again for every request, and tries again after a wait", async () => {
    const down = { now: true };
    const aws = fakeSecrets({ value: SECRET }, down);
    const derive = deriver(aws);

    await expect(derive("pairwise-id")).rejects.toThrow("unreachable");
    vi.setSystemTime(PUSH_ID_SECRET_RETRY_MS - 1);
    await expect(derive("pairwise-id")).rejects.toThrow(
      "failed to fetch moments ago",
    );
    expect(aws.call).toHaveBeenCalledTimes(1);

    down.now = false;
    vi.setSystemTime(PUSH_ID_SECRET_RETRY_MS);
    expect(await derive("pairwise-id")).toBe(PUSH_ID);
    expect(aws.call).toHaveBeenCalledTimes(2);
  });

  it("fails while the secret has no value, without reading again for every request, and derives once a person has put one", async () => {
    const stored: { value: string | undefined } = { value: undefined };
    const aws = fakeSecrets(stored);
    const derive = deriver(aws);

    await expect(derive("pairwise-id")).rejects.toThrow(
      "The push ID secret has no value",
    );
    stored.value = SECRET;
    await expect(derive("pairwise-id")).rejects.toThrow(
      "failed to fetch moments ago",
    );
    expect(aws.call).toHaveBeenCalledTimes(1);

    vi.setSystemTime(PUSH_ID_SECRET_RETRY_MS);
    expect(await derive("pairwise-id")).toBe(PUSH_ID);
    expect(aws.call).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["no value yet", undefined],
    ["an empty value", ""],
    ["only whitespace", " \n"],
  ])("refuses a secret with %s", async (_, value) => {
    const aws = fakeSecrets({ value });
    await expect(deriver(aws)("pairwise-id")).rejects.toThrow(
      "The push ID secret has no value",
    );
  });
});
