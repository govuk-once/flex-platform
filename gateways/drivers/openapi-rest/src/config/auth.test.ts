import type { SecretProvider, Validator } from "@repo/gateway-types";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type {
  OpenApiRestAuthDeps,
  OpenApiRestAuthRequest,
  OpenApiRestAuthTransport,
} from "./auth.ts";
import { apiKey, bearerToken, defineAuth, noAuth } from "./auth.ts";

// Serves the given values in turn, then repeats the last, as a provider whose cached secret
// was rotated between reads would.
function secretOf<T>(...values: T[]): SecretProvider<T> {
  let index = 0;
  return {
    get() {
      const value = values[Math.min(index, values.length - 1)]!;
      index += 1;
      return Promise.resolve(value);
    },
  };
}

const transport: OpenApiRestAuthTransport = {
  request: () => Promise.reject(new Error("unused")),
};

function requestFor(operation = "op"): OpenApiRestAuthRequest {
  return {
    operation,
    signal: new AbortController().signal,
    method: "GET",
    url: new URL("https://api.test/v1/things"),
    headers: new Headers({ accept: "application/json" }),
    body: undefined,
  };
}

function failures(validator: Validator, data: unknown): string[] {
  expect(validator(data)).toBe(false);
  return (validator.errors ?? []).map(
    (e) => `${e.instancePath || "/"} ${e.schemaPath}`,
  );
}

describe("noAuth", () => {
  const auth = noAuth();

  it("accepts only the empty object", () => {
    expect(auth.validateSecret({})).toBe(true);
    expect(auth.validateSecret.errors).toBeNull();
    expect(failures(auth.validateSecret, { token: "SYNTHETIC" })).toEqual([
      "/ #/additionalProperties",
    ]);
    expect(failures(auth.validateSecret, null)).toEqual(["/ #/type"]);
    expect(failures(auth.validateSecret, [])).toEqual(["/ #/type"]);
  });

  it("owns no headers and sets none", async () => {
    expect(auth.headers).toEqual([]);
    const instance = auth.create({ secret: secretOf({}), transport });
    await expect(instance.headers(requestFor())).resolves.toEqual({});
  });
});

describe("bearerToken", () => {
  const auth = bearerToken();

  it("requires a non-empty string token and nothing else", () => {
    expect(auth.validateSecret({ token: "t" })).toBe(true);
    expect(failures(auth.validateSecret, {})).toEqual(["/ #/required"]);
    expect(failures(auth.validateSecret, { token: 1 })).toEqual([
      "/token #/properties/token/type",
    ]);
    expect(failures(auth.validateSecret, { token: "" })).toEqual([
      "/token #/properties/token/minLength",
    ]);
    expect(failures(auth.validateSecret, { token: "a\nb" })).toEqual([
      "/token #/properties/token/pattern",
    ]);
    expect(failures(auth.validateSecret, { token: "a\u0001b" })).toEqual([
      "/token #/properties/token/pattern",
    ]);
    // Headers would strip the padding, so the upstream would not see the stored value.
    expect(failures(auth.validateSecret, { token: " t " })).toEqual([
      "/token #/properties/token/pattern",
    ]);
    expect(failures(auth.validateSecret, { token: "   " })).toEqual([
      "/token #/properties/token/pattern",
    ]);
    expect(failures(auth.validateSecret, { token: "t", extra: 1 })).toEqual([
      "/ #/additionalProperties",
    ]);
  });

  it("keeps values and unexpected field names out of its findings", () => {
    auth.validateSecret({ token: "SYNTHETIC_VALUE\n", SYNTHETIC_KEY: "x" });
    expect(JSON.stringify(auth.validateSecret.errors)).not.toMatch(/SYNTHETIC/);
  });

  it("sends the current token and follows a rotation", async () => {
    expect(auth.headers).toEqual(["authorization"]);
    const instance = auth.create({
      secret: secretOf({ token: "first" }, { token: "second" }),
      transport,
    });
    await expect(instance.headers(requestFor())).resolves.toEqual({
      authorization: "Bearer first",
    });
    await expect(instance.headers(requestFor())).resolves.toEqual({
      authorization: "Bearer second",
    });
  });
});

describe("apiKey", () => {
  it("owns the named header, lowercased, and sends the key in it", async () => {
    const auth = apiKey({ header: "X-Api-Key" });
    expect(auth.headers).toEqual(["x-api-key"]);
    expect(auth.validateSecret({ apiKey: "k" })).toBe(true);
    expect(failures(auth.validateSecret, { token: "k" })).toEqual([
      "/ #/required",
      "/ #/additionalProperties",
    ]);
    const instance = auth.create({
      secret: secretOf({ apiKey: "k1" }),
      transport,
    });
    await expect(instance.headers(requestFor())).resolves.toEqual({
      "x-api-key": "k1",
    });
  });

  it("rejects a reserved or invalid header name when defined", () => {
    expect(() => apiKey({ header: "host" })).toThrow(
      'apiKey auth: header "host" is set by the driver',
    );
    expect(() => apiKey({ header: "x y" })).toThrow(/not a valid header name/);
  });
});

describe("defineAuth", () => {
  it("returns the definition and types create from the validator", () => {
    const isClientSecret = (
      data: unknown,
    ): data is { clientId: string; clientSecret: string } =>
      typeof data === "object" && data !== null && "clientId" in data;
    const create = vi.fn(
      (
        _deps: OpenApiRestAuthDeps<{ clientId: string; clientSecret: string }>,
      ) => ({
        headers: () => Promise.resolve({}),
      }),
    );
    const definition = {
      validateSecret: isClientSecret,
      headers: ["authorization"],
      create,
    };
    const auth = defineAuth(definition);
    expect(auth).toBe(definition);
    expectTypeOf<typeof auth>()
      .toHaveProperty("create")
      .parameter(0)
      .toEqualTypeOf<
        OpenApiRestAuthDeps<{ clientId: string; clientSecret: string }>
      >();

    // Without an annotation, `deps.secret` is still typed from the validator.
    defineAuth({
      validateSecret: isClientSecret,
      headers: [],
      create: (deps) => {
        expectTypeOf(deps.secret).toEqualTypeOf<
          SecretProvider<{ clientId: string; clientSecret: string }>
        >();
        return { headers: () => Promise.resolve({}) };
      },
    });
  });
});
