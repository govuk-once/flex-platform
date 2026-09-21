// A local server standing in for Secrets Manager, so the SDK's own HTTP handler runs against
// a request nothing answers. Not a network call the runtime makes.
// eslint-disable-next-line no-restricted-imports
import http from "node:http";

import type { GetSecretValueCommandOutput } from "@aws-sdk/client-secrets-manager";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GatewayError } from "./errors.ts";
import { asSecretObject, createSecretProvider } from "./secret-provider.ts";

const ARN = "arn:aws:secretsmanager:eu-west-2:123456789012:secret:udp-AbCdEf";

type Output = Partial<GetSecretValueCommandOutput>;

// Answers every SDK client's send locally, so Powertools runs as deployed, with its own cache
// and transform, and nothing reaches AWS. The SDK's send is overloaded with a callback form,
// which the lint rule reads as a void-returning signature; the mock only serves the promise
// form. `this` is the client Powertools built, so a test can inspect its configuration.
function answering(
  impl: (
    this: SecretsManagerClient,
    command: GetSecretValueCommand,
  ) => Promise<Output>,
) {
  return vi
    .spyOn(SecretsManagerClient.prototype, "send")
    .mockImplementation(impl as never);
}

function secretString(value: unknown): Output {
  return { SecretString: JSON.stringify(value), VersionId: "v1" };
}

async function failure(promise: Promise<unknown>): Promise<GatewayError> {
  const err = await promise.then(
    () => new Error("did not reject"),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GatewayError);
  return err as GatewayError;
}

describe("asSecretObject", () => {
  it("accepts an object, including the empty one", () => {
    expect(asSecretObject({})).toEqual({});
    expect(asSecretObject({ token: "  padded\n" })).toEqual({
      token: "  padded\n",
    });
  });

  it.each([
    ["undefined", undefined, /has no value/],
    ["an array", ["SYNTHETIC_SECRET"], /not an array/],
    ["a string", "SYNTHETIC_SECRET", /not a string/],
    ["a number", 42, /not a number/],
    ["a boolean", true, /not a boolean/],
    ["null", null, /not null/],
  ])("rejects %s without quoting it", (_label, input, message) => {
    const err = (() => {
      try {
        asSecretObject(input);
      } catch (e: unknown) {
        return e as GatewayError;
      }
      return new GatewayError("INTERNAL", "did not throw");
    })();
    expect(err.code).toBe("INTERNAL");
    expect(err.message).toMatch(message);
    expect(err.message).not.toContain("SYNTHETIC");
    expect(err.message).not.toContain("42");
  });
});

describe("createSecretProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    "",
    "udp-secret",
    "arn:aws:ssm:eu-west-2:123456789012:parameter/x",
    "arn:aws:secretsmanager::123456789012:secret:no-region",
    "arn:aws:secretsmanager:eu-west-2:123456789012:secret:",
    "arn:aws:secretsmanager:eu-west-2:123456789012:secret:has space",
  ])("rejects %j at creation", (arn) => {
    expect(() => createSecretProvider(arn)).toThrow(
      /needs a Secrets Manager secret ARN/,
    );
  });

  it("reads the secret by ARN, in the ARN's region, and returns the parsed object", async () => {
    let region: string | undefined;
    const send = answering(async function () {
      region = await this.config.region();
      return secretString({ token: "t1" });
    });
    await expect(createSecretProvider(ARN).get()).resolves.toEqual({
      token: "t1",
    });
    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0]!;
    expect(command).toBeInstanceOf(GetSecretValueCommand);
    expect((command as GetSecretValueCommand).input.SecretId).toBe(ARN);
    expect(region).toBe("eu-west-2");
  });

  it("accepts a partition and region other than the default", async () => {
    let region: string | undefined;
    answering(async function () {
      region = await this.config.region();
      return secretString({});
    });
    await createSecretProvider(
      "arn:aws-cn:secretsmanager:cn-north-1:123456789012:secret:x",
    ).get();
    expect(region).toBe("cn-north-1");
  });

  describe("with a clock", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
    });

    it("serves the cached value for five minutes, then reads again", async () => {
      let calls = 0;
      const send = answering(() => {
        calls += 1;
        return Promise.resolve(secretString({ token: `t${calls}` }));
      });
      const provider = createSecretProvider(ARN);
      await expect(provider.get()).resolves.toEqual({ token: "t1" });
      vi.setSystemTime(299_000);
      await expect(provider.get()).resolves.toEqual({ token: "t1" });
      expect(send).toHaveBeenCalledTimes(1);

      // Rotation: the first call after the age sees the new value.
      vi.setSystemTime(301_000);
      await expect(provider.get()).resolves.toEqual({ token: "t2" });
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("keeps one cache per provider", async () => {
      const send = answering(() => Promise.resolve(secretString({})));
      await createSecretProvider(ARN).get();
      await createSecretProvider(ARN).get();
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  it("answers concurrent callers, each of which may read", async () => {
    answering(() => Promise.resolve(secretString({ token: "t1" })));
    const provider = createSecretProvider(ARN);
    const values = await Promise.all([provider.get(), provider.get()]);
    expect(values).toEqual([{ token: "t1" }, { token: "t1" }]);
  });

  it("accepts a binary secret holding a JSON object", async () => {
    answering(() =>
      Promise.resolve({
        SecretBinary: new TextEncoder().encode('{"token":"t1"}'),
      }),
    );
    await expect(createSecretProvider(ARN).get()).resolves.toEqual({
      token: "t1",
    });
  });

  it("replaces a retrieval failure with a fixed diagnostic, keeping nothing of the error", async () => {
    const libraryError = Object.assign(new Error("token=SYNTHETIC_MESSAGE"), {
      name: "SYNTHETIC_NAME",
      $response: { body: "SYNTHETIC_BODY" },
      cause: new Error("SYNTHETIC_CAUSE"),
    });
    answering(() => Promise.reject(libraryError));
    const err = await failure(createSecretProvider(ARN).get());
    expect(err.code).toBe("INTERNAL");
    expect(err.message).toBe("Failed to retrieve gateway secret");
    expect(err.cause).toBeUndefined();
    expect(JSON.stringify(err)).not.toMatch(/SYNTHETIC/);
  });

  it("replaces malformed JSON with the same diagnostic", async () => {
    answering(() => Promise.resolve({ SecretString: "{SYNTHETIC_SECRET" }));
    const err = await failure(createSecretProvider(ARN).get());
    expect(err.message).toBe("Failed to retrieve gateway secret");
  });

  it("rejects a secret that is not a JSON object", async () => {
    answering(() => Promise.resolve(secretString(["SYNTHETIC"])));
    const err = await failure(createSecretProvider(ARN).get());
    expect(err.message).toBe(
      "Gateway secret must be a JSON object, not an array",
    );
  });

  it("rejects a secret with no value", async () => {
    answering(() => Promise.resolve({}));
    const err = await failure(createSecretProvider(ARN).get());
    expect(err.message).toMatch(/has no value/);
  });

  it("does not cache a failure", async () => {
    let calls = 0;
    const send = answering(() => {
      calls += 1;
      return Promise.resolve(
        calls === 1 ? { SecretString: "nope" } : secretString({ a: 1 }),
      );
    });
    const provider = createSecretProvider(ARN);
    await failure(provider.get());
    await expect(provider.get()).resolves.toEqual({ a: 1 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("rejects a request the store never answers once the request timeout passes", async () => {
    // The SDK's own HTTP handler against a local server that accepts the request and never
    // answers, so only the handler's request timeout can end it. Timers are faked so the
    // configured seconds pass at once; the sockets are real.
    const server = http.createServer(() => undefined);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as { port: number };
    vi.stubEnv("AWS_ENDPOINT_URL_SECRETS_MANAGER", `http://127.0.0.1:${port}`);
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIASYNTHETIC");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "SYNTHETIC");
    vi.stubEnv("AWS_MAX_ATTEMPTS", "1");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const received = new Promise<void>((resolve) => {
        server.once("request", () => resolve());
      });
      const pending = failure(createSecretProvider(ARN).get());
      await received;
      await vi.advanceTimersByTimeAsync(5_000);
      const err = await pending;
      expect(err.message).toBe("Failed to retrieve gateway secret");
    } finally {
      vi.useRealTimers();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
