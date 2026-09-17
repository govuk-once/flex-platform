import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readUpstreamOptions,
  readUpstreamSecretArn,
  readUpstreamTarget,
  UPSTREAM_SECRET_ARN_ENV,
  UPSTREAM_TARGET_ENV,
} from "./upstream-target.ts";

const ARN = "arn:aws:secretsmanager:eu-west-2:123456789012:secret:udp-AbCdEf";

describe("readUpstreamTarget", () => {
  it("returns the configured value", () => {
    expect(
      readUpstreamTarget({ [UPSTREAM_TARGET_ENV]: "https://x.test" }),
    ).toBe("https://x.test");
  });

  it("trims surrounding whitespace", () => {
    expect(readUpstreamTarget({ [UPSTREAM_TARGET_ENV]: "  arn:x  " })).toBe(
      "arn:x",
    );
  });

  it("throws when unset", () => {
    expect(() => readUpstreamTarget({})).toThrow(/UPSTREAM_TARGET must be set/);
  });

  it("throws when blank", () => {
    expect(() => readUpstreamTarget({ [UPSTREAM_TARGET_ENV]: "   " })).toThrow(
      /UPSTREAM_TARGET must be set/,
    );
  });
});

describe("readUpstreamSecretArn", () => {
  it("returns the trimmed value", () => {
    expect(
      readUpstreamSecretArn({ [UPSTREAM_SECRET_ARN_ENV]: ` ${ARN} ` }),
    ).toBe(ARN);
  });

  it("throws when unset or blank", () => {
    expect(() => readUpstreamSecretArn({})).toThrow(
      /UPSTREAM_SECRET_ARN must be set/,
    );
    expect(() =>
      readUpstreamSecretArn({ [UPSTREAM_SECRET_ARN_ENV]: " " }),
    ).toThrow(/UPSTREAM_SECRET_ARN must be set/);
  });

  it("does not judge the value's shape; the provider does", () => {
    expect(
      readUpstreamSecretArn({ [UPSTREAM_SECRET_ARN_ENV]: "udp-secret" }),
    ).toBe("udp-secret");
  });
});

describe("readUpstreamOptions", () => {
  const env = {
    [UPSTREAM_TARGET_ENV]: "https://x.test",
    [UPSTREAM_SECRET_ARN_ENV]: ARN,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the target and a provider for the named secret", async () => {
    const send = vi
      .spyOn(SecretsManagerClient.prototype, "send")
      .mockImplementation((() =>
        Promise.resolve({ SecretString: "{}" })) as never);
    const options = readUpstreamOptions(env);
    expect(options.target).toBe("https://x.test");
    // Reading the environment retrieves nothing; the executor does that when created.
    expect(send).not.toHaveBeenCalled();
    await expect(options.secret.get()).resolves.toEqual({});
    const [command] = send.mock.calls[0]!;
    expect(command).toBeInstanceOf(GetSecretValueCommand);
    expect((command as GetSecretValueCommand).input.SecretId).toBe(ARN);
  });

  it("rejects a value that is not a Secrets Manager ARN", () => {
    expect(() =>
      readUpstreamOptions({ ...env, [UPSTREAM_SECRET_ARN_ENV]: "udp-secret" }),
    ).toThrow(/needs a Secrets Manager secret ARN/);
  });

  it("requires both variables", () => {
    expect(() =>
      readUpstreamOptions({ [UPSTREAM_SECRET_ARN_ENV]: ARN }),
    ).toThrow(/UPSTREAM_TARGET must be set/);
    expect(() =>
      readUpstreamOptions({ [UPSTREAM_TARGET_ENV]: "https://x.test" }),
    ).toThrow(/UPSTREAM_SECRET_ARN must be set/);
  });
});
