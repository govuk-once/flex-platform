import { describe, expect, it } from "vitest";

import type {
  OpenApiRestAuth,
  OpenApiRestAuthRequest,
  OpenApiRestAuthTransport,
} from "./auth.ts";
import { apiKey, defineAuth } from "./auth.ts";
import { fromSecret, type SecretValues } from "./secret-field.ts";

// Serves the given fields in turn, then repeats the last, as the secret's fields would read
// when the secret was rotated between reads.
function secretOf(...reads: Record<string, string>[]): {
  get(): Promise<SecretValues>;
} {
  let index = 0;
  return {
    get() {
      const fields = reads[Math.min(index, reads.length - 1)] ?? {};
      index += 1;
      return Promise.resolve({
        get: (field) =>
          Object.hasOwn(fields, field.secretField)
            ? fields[field.secretField]
            : undefined,
      });
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

describe("apiKey", () => {
  it("owns the named header, lowercased, and sends the key its secret field holds", async () => {
    const key = fromSecret("consumerApiKey");
    const auth = apiKey({ header: "X-Api-Key", key });
    expect(auth.headers).toEqual(["x-api-key"]);
    expect(auth.fields).toEqual([key]);

    const instance = auth.create({
      secret: secretOf({ consumerApiKey: "k1" }, { consumerApiKey: "k2" }),
      transport,
    });
    await expect(instance.headers(requestFor())).resolves.toEqual({
      "x-api-key": "k1",
    });
    // Read afresh for each request, so a rotated key is sent from the next one.
    await expect(instance.headers(requestFor())).resolves.toEqual({
      "x-api-key": "k2",
    });
  });

  it("sends nothing where an optional field is absent", async () => {
    const auth = apiKey({
      header: "x-api-key",
      key: fromSecret("apiKey", { optional: true }),
    });
    const instance = auth.create({ secret: secretOf({}), transport });
    await expect(instance.headers(requestFor())).resolves.toEqual({});
  });

  it("rejects a reserved or invalid header name, and a key that is not a secret field", () => {
    const key = fromSecret("apiKey");
    expect(() => apiKey({ header: "host", key })).toThrow(
      'apiKey auth: header "host" is set by the driver',
    );
    expect(() => apiKey({ header: "x y", key })).toThrow(
      /not a valid header name/,
    );
    expect(() =>
      // @ts-expect-error a key is never written into a configuration
      apiKey({ header: "x-api-key", key: "SYNTHETIC" }),
    ).toThrow(/must name the secret field that holds it, with fromSecret/);
  });
});

describe("defineAuth", () => {
  it("returns the part it is given", () => {
    const part: OpenApiRestAuth = {
      headers: ["authorization"],
      fields: [fromSecret("username"), fromSecret("password")],
      create: () => ({ headers: () => Promise.resolve({}) }),
    };
    expect(defineAuth(part)).toBe(part);
  });
});

describe("fromSecret", () => {
  it("names a field, required unless it says otherwise", () => {
    expect(fromSecret("roleArn")).toEqual({
      secretField: "roleArn",
      optional: false,
    });
    expect(fromSecret("externalId", { optional: true })).toEqual({
      secretField: "externalId",
      optional: true,
    });
  });

  it("refuses a name that is empty or has space around it", () => {
    for (const name of ["", " roleArn"]) {
      expect(() => fromSecret(name)).toThrow(TypeError);
    }
  });
});
