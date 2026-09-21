import { GatewayError } from "@repo/gateway-runtime";
import type { SecretProvider, Validator } from "@repo/gateway-types";
import { describe, expect, it, vi } from "vitest";

import { fakeSecret } from "../../test/helpers.ts";
import { describeSecretFindings, validatedSecret } from "./secret.ts";

interface TokenSecret {
  readonly token: string;
}

function tokenValidator(
  onCall: () => void = () => undefined,
): Validator<TokenSecret> {
  const validator: Validator<TokenSecret> = Object.assign(
    (data: unknown): data is TokenSecret => {
      onCall();
      const ok =
        typeof data === "object" &&
        data !== null &&
        typeof (data as { token?: unknown }).token === "string";
      validator.errors = ok
        ? null
        : [{ instancePath: "/token", schemaPath: "#/properties/token/type" }];
      return ok;
    },
    { errors: null },
  );
  return validator;
}

async function failure(promise: Promise<unknown>): Promise<GatewayError> {
  const err = await promise.then(
    () => new Error("did not reject"),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GatewayError);
  return err as GatewayError;
}

describe("describeSecretFindings", () => {
  it("lists schema locations, at most five, and never messages or paths", () => {
    expect(
      describeSecretFindings([
        { instancePath: "", schemaPath: "#/required", message: "SYNTHETIC" },
        { instancePath: "/token", schemaPath: "#/properties/token/type" },
      ]),
    ).toBe("failed validation at #/required, #/properties/token/type");
    // Under a dictionary schema the instance path is made of the secret's own keys.
    const described = describeSecretFindings([
      {
        instancePath: "/credentials/SYNTHETIC_SECRET_KEY",
        schemaPath: "#/properties/credentials/additionalProperties/type",
      },
    ]);
    expect(described).toBe(
      "failed validation at #/properties/credentials/additionalProperties/type",
    );
    expect(described).not.toContain("SYNTHETIC");
    expect(describeSecretFindings(null)).toBe(
      "did not match the expected shape",
    );
    expect(
      describeSecretFindings(
        Array.from({ length: 7 }, (_, i) => ({
          instancePath: `/f${i}`,
          schemaPath: "#/type",
        })),
      ).match(/#\/type/g),
    ).toHaveLength(5);
  });
});

describe("validatedSecret", () => {
  it("validates every read and returns the typed value", async () => {
    const calls = vi.fn();
    const secret = fakeSecret({ token: "t1" });
    const validated = validatedSecret(
      "gw",
      secret.provider,
      tokenValidator(calls),
    );
    await expect(validated.get()).resolves.toEqual({ token: "t1" });
    await expect(validated.get()).resolves.toEqual({ token: "t1" });
    expect(calls).toHaveBeenCalledTimes(2);

    secret.rotate({ token: "t2" });
    await expect(validated.get()).resolves.toEqual({ token: "t2" });
    expect(calls).toHaveBeenCalledTimes(3);
  });

  it("never returns an invalid value, whatever it read before", async () => {
    const secret = fakeSecret({ token: "t1" });
    const validated = validatedSecret("gw", secret.provider, tokenValidator());
    await validated.get();

    secret.rotate({ token: 42 });
    const err = await failure(validated.get());
    expect(err.code).toBe("INTERNAL");
    expect(err.message).toBe(
      'Gateway "gw" secret failed validation at #/properties/token/type',
    );
    expect(err.message).not.toContain("42");
    await failure(validated.get());

    secret.rotate({ token: "t3" });
    await expect(validated.get()).resolves.toEqual({ token: "t3" });
  });

  it("replaces a validator that throws with a fixed diagnostic", async () => {
    const throwing: Validator<TokenSecret> = Object.assign(
      (_data: unknown): _data is TokenSecret => {
        throw new Error("SYNTHETIC token=abc");
      },
      { errors: null },
    );
    const err = await failure(
      validatedSecret(
        "gw",
        fakeSecret({ token: "t" }).provider,
        throwing,
      ).get(),
    );
    expect(err.message).toBe('Gateway "gw" secret validator threw');
  });

  it("keeps a GatewayError from the provider and replaces anything else", async () => {
    const own = new GatewayError(
      "INTERNAL",
      "Failed to retrieve gateway secret",
    );
    const failing: SecretProvider = { get: () => Promise.reject(own) };
    expect(
      await failure(validatedSecret("gw", failing, tokenValidator()).get()),
    ).toBe(own);

    const library: SecretProvider = {
      get: () => Promise.reject(new Error("SYNTHETIC")),
    };
    const err = await failure(
      validatedSecret("gw", library, tokenValidator()).get(),
    );
    expect(err.message).toBe('Gateway "gw" secret retrieval failed');
  });
});
