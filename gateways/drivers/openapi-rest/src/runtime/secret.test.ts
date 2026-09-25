import { GatewayError } from "@repo/gateway-runtime";
import type { SecretProvider } from "@repo/gateway-types";
import { describe, expect, it } from "vitest";

import { fakeSecret } from "../../test/helpers.ts";
import { fromSecret } from "../config/secret-field.ts";
import { secretFields } from "./secret.ts";

const KEY = fromSecret("apiKey");
const EXTERNAL_ID = fromSecret("externalId", { optional: true });

async function failure(promise: Promise<unknown>): Promise<GatewayError> {
  const err = await promise.then(
    () => new Error("did not reject"),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GatewayError);
  return err as GatewayError;
}

describe("secretFields", () => {
  it("reads the fields a gateway names, and nothing else, on every read", async () => {
    // An upstream's own secret, holding fields no part of this gateway reads.
    const secret = fakeSecret({
      apiKey: "k1",
      apiAccountId: "000000000000",
      region: "eu-west-2",
    });
    const fields = secretFields("gw", secret.provider, [KEY, EXTERNAL_ID]);

    const first = await fields.get();
    expect(first.get(KEY)).toBe("k1");
    expect(first.get(EXTERNAL_ID)).toBeUndefined();
    expect(first.get(fromSecret("region"))).toBeUndefined();

    secret.rotate({ apiKey: "k2", externalId: "e1" });
    const rotated = await fields.get();
    expect(rotated.get(KEY)).toBe("k2");
    expect(rotated.get(EXTERNAL_ID)).toBe("e1");
    expect(secret.reads()).toBe(2);
  });

  it.each([
    ["missing", {}, 'field "apiKey" is missing'],
    [
      "not a string",
      { apiKey: 42 },
      'field "apiKey" is not a non-empty string',
    ],
    ["empty", { apiKey: "" }, 'field "apiKey" is not a non-empty string'],
    [
      "not something a header can carry as written",
      { apiKey: " SYNTHETIC" },
      'field "apiKey" holds a character or a surrounding space it cannot be sent with',
    ],
  ])(
    "refuses a named field that is %s, never quoting it",
    async (_what, value, problem) => {
      const err = await failure(
        secretFields("gw", fakeSecret(value).provider, [KEY]).get(),
      );
      expect(err.code).toBe("INTERNAL");
      expect(err.message).toBe(`Gateway "gw" secret ${problem}`);
      expect(err.message).not.toContain("SYNTHETIC");
    },
  );

  it("holds an optional field that is there to the same rules", async () => {
    const err = await failure(
      secretFields("gw", fakeSecret({ externalId: 7 }).provider, [
        EXTERNAL_ID,
      ]).get(),
    );
    expect(err.message).toBe(
      'Gateway "gw" secret field "externalId" is not a non-empty string',
    );
  });

  it("reads a field only as the secret's own, not as one every object inherits", async () => {
    const err = await failure(
      secretFields("gw", fakeSecret({}).provider, [
        fromSecret("constructor"),
      ]).get(),
    );
    expect(err.message).toBe(
      'Gateway "gw" secret field "constructor" is missing',
    );
  });

  it("refuses a secret that is not an object", async () => {
    const err = await failure(
      secretFields("gw", fakeSecret("SYNTHETIC").provider, [KEY]).get(),
    );
    expect(err.message).toBe('Gateway "gw" secret is not an object');
  });

  it("keeps a GatewayError from the provider and replaces anything else", async () => {
    const own = new GatewayError(
      "INTERNAL",
      "Failed to retrieve gateway secret",
    );
    const failing: SecretProvider = { get: () => Promise.reject(own) };
    expect(await failure(secretFields("gw", failing, [KEY]).get())).toBe(own);

    const library: SecretProvider = {
      get: () => Promise.reject(new Error("SYNTHETIC")),
    };
    const err = await failure(secretFields("gw", library, [KEY]).get());
    expect(err.message).toBe('Gateway "gw" secret retrieval failed');
  });
});
