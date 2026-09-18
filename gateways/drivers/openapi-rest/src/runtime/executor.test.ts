import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { BrandedHandler } from "@repo/gateway-config";
import { defineGateway } from "@repo/gateway-config";
import {
  createHandler,
  createSecretProvider,
  GatewayError,
} from "@repo/gateway-runtime";
import type {
  OperationHandler,
  SecretProvider,
  Validator,
} from "@repo/gateway-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fakeFetch,
  fakeSecret,
  headerOf,
  json,
  passthroughContext,
} from "../../test/helpers.ts";
import type { OpenApiRestAuth } from "../config/auth.ts";
import { apiKey, bearerToken, defineAuth, noAuth } from "../config/auth.ts";
import type { OpenApiRestDriverConfig } from "../config/definition.ts";
import { openapiRest } from "../config/definition.ts";
import { defineHandler } from "../config/handler.ts";
import { encodePathParam } from "../path.ts";
import { buildExecutor, createExecutor } from "./executor.ts";

const SPEC = "https://example.test/openapi.yml";
const TARGET = "https://api.test";
const ARN = "arn:aws:secretsmanager:eu-west-2:123456789012:secret:x-AbCdEf";
const DRIVER = openapiRest({
  spec: SPEC,
  auth: noAuth(),
  headers: { "x-api-version": "2" },
});

// A gateway that sends no credential still has a secret: the empty object.
function emptySecret(): SecretProvider {
  return fakeSecret({}).provider;
}

// A handler is any value from defineHandler; it lives wherever the config author puts it.
const customHandler = defineHandler(async (input: { id: string }, client) => {
  const response = await client.request({
    method: "GET",
    path: `/custom/${encodePathParam(input.id, "custom handler")}`,
    headers: { "x-custom": "yes" },
  });
  return { outcome: "custom", data: { status: response.status } };
});

const gateway = defineGateway({
  id: "users",
  driver: DRIVER,
  operations: {
    getUser: {
      upstream: "GET /users/{id}",
      parameters: {
        userId: { in: "path", name: "id" },
        token: { in: "header", name: "x-token" },
      },
    },
    createUser: { upstream: "POST /users" },
    custom: {
      upstream: "GET /custom/{id}",
      parameters: { id: { in: "path" } },
      handler: customHandler,
    },
  },
});

// One operation on a driver with the given auth; the shape most tests here need.
function gatewayWith(
  auth: OpenApiRestAuth,
  driver: Partial<OpenApiRestDriverConfig> = {},
) {
  return defineGateway({
    id: "x",
    driver: openapiRest({ spec: SPEC, auth, ...driver }),
    operations: { op: { upstream: "GET /x" } },
  });
}

const accept: Validator = Object.assign(
  (_data: unknown): _data is unknown => true,
  { errors: null },
);

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const err = await promise.then(
    () => new Error("did not reject"),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

describe("createExecutor", () => {
  it("is carried by the driver definition, as an entrypoint reaches it", async () => {
    const config = gatewayWith(noAuth());
    const execute = await config.driver.createExecutor(config, {
      target: TARGET,
      secret: emptySecret(),
    });
    expect(execute).toBeTypeOf("function");
  });

  it("types an operation's handler against the driver's branded handler", () => {
    const plain = (input: unknown) =>
      Promise.resolve({ outcome: "ok", data: input });
    const foreign = plain as unknown as BrandedHandler<"other", typeof plain>;
    const gw = defineGateway({
      id: "x",
      driver: DRIVER,
      operations: {
        wrongInput: {
          upstream: "GET /x",
          // @ts-expect-error a handler must accept unknown input and the client
          handler: (input: string) =>
            Promise.resolve({ outcome: "ok", data: input }),
        },
        unbranded: {
          upstream: "GET /x",
          // @ts-expect-error a plain function was not written through this driver's defineHandler
          handler: plain,
        },
        foreign: {
          upstream: "GET /x",
          // @ts-expect-error a handler branded for another driver is rejected
          handler: foreign,
        },
      },
    });
    // The branding is a type-level check; each handler is still carried as written.
    expect(Object.keys(gw.operations)).toEqual([
      "wrongInput",
      "unbranded",
      "foreign",
    ]);
    expect(gw.operations).toMatchObject({
      unbranded: { handler: plain },
      foreign: { handler: foreign },
    });
  });

  it("rejects a handler that is not a function", async () => {
    const broken = defineGateway({
      id: "x",
      driver: DRIVER,
      operations: {
        op: {
          upstream: "GET /x",
          handler: {} as unknown as OperationHandler as typeof customHandler,
        },
      },
    });
    await expect(
      createExecutor(broken, { target: TARGET, secret: emptySecret() }),
    ).rejects.toThrow('Operation "op": handler must be a function');
  });

  it("checks configuration before it retrieves the secret", async () => {
    const secret = fakeSecret({});
    await expect(
      createExecutor(gateway, { target: "nope", secret: secret.provider }),
    ).rejects.toThrow(/absolute http or https URL/);
    expect(secret.reads()).toBe(0);
  });

  it("sends a bearer token from the secret", async () => {
    const ff = fakeFetch(() => json(200, {}));
    const execute = await buildExecutor(
      gatewayWith(bearerToken()),
      { target: TARGET, secret: fakeSecret({ token: "tok" }).provider },
      { fetch: ff.fetch },
    );
    await execute(passthroughContext(), "op", {});
    expect(headerOf(ff.calls[0]!, "authorization")).toBe("Bearer tok");
  });

  it("sends an API key in the declared header", async () => {
    const ff = fakeFetch(() => json(200, {}));
    const execute = await buildExecutor(
      gatewayWith(apiKey({ header: "X-Api-Key" })),
      { target: TARGET, secret: fakeSecret({ apiKey: "key" }).provider },
      { fetch: ff.fetch },
    );
    await execute(passthroughContext(), "op", {});
    expect(headerOf(ff.calls[0]!, "x-api-key")).toBe("key");
  });

  it("sends no credential for noAuth and requires the empty object", async () => {
    const ff = fakeFetch(() => json(200, {}));
    const execute = await buildExecutor(
      gatewayWith(noAuth()),
      { target: TARGET, secret: emptySecret() },
      { fetch: ff.fetch },
    );
    await execute(passthroughContext(), "op", {});
    expect(headerOf(ff.calls[0]!, "authorization")).toBeNull();

    const err = await rejection(
      createExecutor(gatewayWith(noAuth()), {
        target: TARGET,
        secret: fakeSecret({ token: "SYNTHETIC" }).provider,
      }),
    );
    expect(err.message).toBe(
      'Gateway "x" secret failed validation at #/additionalProperties',
    );
    expect(err.message).not.toContain("SYNTHETIC");
  });

  it("does not initialise on a missing or invalid secret, and never quotes it", async () => {
    const missing = await rejection(
      createExecutor(gatewayWith(bearerToken()), {
        target: TARGET,
        secret: emptySecret(),
      }),
    );
    expect(missing).toBeInstanceOf(GatewayError);
    expect(missing.message).toBe(
      'Gateway "x" secret failed validation at #/required',
    );

    const invalid = await rejection(
      createExecutor(gatewayWith(bearerToken()), {
        target: TARGET,
        secret: fakeSecret({ token: "SYNTHETIC\nSECRET" }).provider,
      }),
    );
    expect(invalid.message).toBe(
      'Gateway "x" secret failed validation at #/properties/token/pattern',
    );
    expect(invalid.message).not.toContain("SYNTHETIC");

    const unavailable = new GatewayError(
      "INTERNAL",
      "Gateway secret retrieval failed: AccessDeniedException",
    );
    const failing: SecretProvider = { get: () => Promise.reject(unavailable) };
    expect(
      await rejection(
        createExecutor(gatewayWith(bearerToken()), {
          target: TARGET,
          secret: failing,
        }),
      ),
    ).toBe(unavailable);
  });

  it("rejects an auth definition that is not one, and one whose create returns no instance", async () => {
    await expect(
      createExecutor(gatewayWith({} as unknown as OpenApiRestAuth), {
        target: TARGET,
        secret: emptySecret(),
      }),
    ).rejects.toThrow(
      /driver auth must be a definition with validateSecret, headers and create/,
    );

    const broken = defineAuth({
      validateSecret: accept,
      headers: [],
      create: () => undefined as never,
    });
    await expect(
      createExecutor(gatewayWith(broken), {
        target: TARGET,
        secret: emptySecret(),
      }),
    ).rejects.toThrow(
      /auth create\(\) must return an instance with a headers function/,
    );
  });

  it("rejects an auth definition declaring a reserved header", async () => {
    const reserved = defineAuth({
      validateSecret: accept,
      headers: ["host"],
      create: () => ({ headers: () => Promise.resolve({}) }),
    });
    await expect(
      createExecutor(gatewayWith(reserved), {
        target: TARGET,
        secret: emptySecret(),
      }),
    ).rejects.toThrow(
      'Driver auth headers: header "host" is set by the driver',
    );
  });

  it("reserves the authentication's headers against static headers and mappings", async () => {
    const staticCollision = gatewayWith(bearerToken(), {
      headers: { Authorization: "Bearer static" },
    });
    await expect(
      createExecutor(staticCollision, {
        target: TARGET,
        secret: fakeSecret({ token: "tok" }).provider,
      }),
    ).rejects.toThrow(
      /header "authorization" is reserved by the driver's authentication/,
    );

    const mappingCollision = defineGateway({
      id: "x",
      driver: openapiRest({
        spec: SPEC,
        auth: apiKey({ header: "X-Api-Key" }),
      }),
      operations: {
        op: {
          upstream: "GET /x",
          parameters: { key: { in: "header", name: "x-api-key" } },
        },
      },
    });
    await expect(
      createExecutor(mappingCollision, {
        target: TARGET,
        secret: fakeSecret({ apiKey: "k" }).provider,
      }),
    ).rejects.toThrow(
      /maps to header "x-api-key", which is reserved by the driver/,
    );
  });

  it("keeps the authentication's header when a handler tries to set it", async () => {
    const ff = fakeFetch(() => json(200, {}));
    const override = defineHandler(async (_input: unknown, client) =>
      client.invoke({
        method: "GET",
        path: "/x",
        headers: { authorization: "Bearer SYNTHETIC" },
      }),
    );
    const execute = await buildExecutor(
      defineGateway({
        id: "x",
        driver: openapiRest({ spec: SPEC, auth: bearerToken() }),
        operations: { op: { upstream: "GET /x", handler: override } },
      }),
      { target: TARGET, secret: fakeSecret({ token: "tok" }).provider },
      { fetch: ff.fetch },
    );
    const err = await rejection(execute(passthroughContext(), "op", {}));
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err.message).toMatch(/reserved by the driver's authentication/);
    expect(err.message).not.toContain("SYNTHETIC");
    expect(ff.calls).toHaveLength(0);
  });

  it("rejects a header the authentication did not declare", async () => {
    const ff = fakeFetch(() => json(200, {}));
    const undeclared = defineAuth({
      validateSecret: accept,
      headers: ["authorization"],
      create: () => ({
        headers: () =>
          Promise.resolve({ authorization: "Bearer t", "X-Extra": "1" }),
      }),
    });
    const execute = await buildExecutor(
      gatewayWith(undeclared),
      { target: TARGET, secret: emptySecret() },
      { fetch: ff.fetch },
    );
    await expect(execute(passthroughContext(), "op", {})).rejects.toMatchObject(
      {
        code: "INTERNAL",
        message:
          'Operation "op": authentication set header "x-extra", which its definition does not declare',
      },
    );
    expect(ff.calls).toHaveLength(0);
  });

  it("rejects a config for another driver", async () => {
    const other = defineGateway({
      id: "x",
      driver: { type: "other", spec: "" } as unknown as typeof DRIVER,
      operations: { op: { upstream: "GET /x" } },
    });
    await expect(
      createExecutor(other, { target: TARGET, secret: emptySecret() }),
    ).rejects.toThrow(/driver type must be "openapi-rest"/);
  });

  it("rejects an operation config at creation", async () => {
    const broken = defineGateway({
      id: "x",
      driver: DRIVER,
      operations: {
        op: {
          upstream: "GET /x/{id}",
          // The type check would reject "nope"; the cast lets the runtime check be exercised.
          parameters: {
            id: { in: "path" },
            f: { in: "path", name: "nope" as "id" },
          },
        },
      },
    });
    await expect(
      createExecutor(broken, { target: TARGET, secret: emptySecret() }),
    ).rejects.toThrow(/"\{nope\}", which is not in the template/);
  });

  it("rejects a non-positive maxResponseBytes on the driver", async () => {
    await expect(
      createExecutor(gatewayWith(noAuth(), { maxResponseBytes: 0 }), {
        target: TARGET,
        secret: emptySecret(),
      }),
    ).rejects.toThrow(/Driver maxResponseBytes must be a positive integer/);
  });

  it("rejects reserved static headers on the driver", async () => {
    await expect(
      createExecutor(gatewayWith(noAuth(), { headers: { host: "x" } }), {
        target: TARGET,
        secret: emptySecret(),
      }),
    ).rejects.toThrow(/Driver headers: header "host"/);
  });
});

describe("secret rotation and refresh", () => {
  it("follows a rotated secret without recreating the executor", async () => {
    const ff = fakeFetch(() => json(200, {}));
    const secret = fakeSecret({ token: "first" });
    const execute = await buildExecutor(
      gatewayWith(bearerToken()),
      { target: TARGET, secret: secret.provider },
      { fetch: ff.fetch },
    );
    await execute(passthroughContext(), "op", {});
    secret.rotate({ token: "second" });
    await execute(passthroughContext(), "op", {});
    expect(ff.calls.map((c) => headerOf(c, "authorization"))).toEqual([
      "Bearer first",
      "Bearer second",
    ]);
    // One read at initialisation, then one per request: nothing is kept from an earlier read.
    expect(secret.reads()).toBe(3);
  });

  it("refuses an invalid replacement and never falls back to the previous token", async () => {
    const ff = fakeFetch(() => json(200, {}));
    const secret = fakeSecret({ token: "first" });
    const execute = await buildExecutor(
      gatewayWith(bearerToken()),
      { target: TARGET, secret: secret.provider },
      { fetch: ff.fetch },
    );
    secret.rotate({ token: "SYNTHETIC\n" });
    const err = await rejection(execute(passthroughContext(), "op", {}));
    expect(err).toMatchObject({
      code: "INTERNAL",
      message:
        'Gateway "x" secret failed validation at #/properties/token/pattern',
    });
    expect(ff.calls).toHaveLength(0);

    secret.rotate({ token: "third" });
    await execute(passthroughContext(), "op", {});
    expect(headerOf(ff.calls[0]!, "authorization")).toBe("Bearer third");
  });

  it("fails the operation when a refresh fails", async () => {
    const ff = fakeFetch(() => json(200, {}));
    const secret = fakeSecret({ token: "first" });
    const execute = await buildExecutor(
      gatewayWith(bearerToken()),
      { target: TARGET, secret: secret.provider },
      { fetch: ff.fetch },
    );
    secret.fail(
      new GatewayError("INTERNAL", "Failed to retrieve gateway secret"),
    );
    await expect(execute(passthroughContext(), "op", {})).rejects.toMatchObject(
      { code: "INTERNAL", message: "Failed to retrieve gateway secret" },
    );
    expect(ff.calls).toHaveLength(0);
  });

  it("sends the refreshed value once the runtime's cached secret has aged", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // The runtime's provider as deployed, over an SDK client answered locally.
    const values = ['{"token":"first"}', '{"token":"second"}'];
    const send = vi
      .spyOn(SecretsManagerClient.prototype, "send")
      .mockImplementation((() =>
        Promise.resolve({ SecretString: values.shift() })) as never);
    try {
      const ff = fakeFetch(() => json(200, {}));
      const execute = await buildExecutor(
        gatewayWith(bearerToken()),
        { target: TARGET, secret: createSecretProvider(ARN) },
        { fetch: ff.fetch },
      );
      await execute(passthroughContext(), "op", {});
      vi.setSystemTime(299_000);
      await execute(passthroughContext(), "op", {});
      vi.setSystemTime(301_000);
      await execute(passthroughContext(), "op", {});
      expect(ff.calls.map((c) => headerOf(c, "authorization"))).toEqual([
        "Bearer first",
        "Bearer first",
        "Bearer second",
      ]);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      send.mockRestore();
      vi.useRealTimers();
    }
  });
});

// A synthetic client-credentials flow: the secret holds the client and the token endpoint,
// the flow exchanges them for a bearer token, caches it until it expires, and shares one
// exchange between concurrent requests.
interface ExchangeSecret {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenUrl: string;
}

const isExchangeSecret: Validator<ExchangeSecret> = Object.assign(
  (data: unknown): data is ExchangeSecret =>
    typeof data === "object" &&
    data !== null &&
    typeof (data as ExchangeSecret).clientId === "string" &&
    typeof (data as ExchangeSecret).clientSecret === "string" &&
    typeof (data as ExchangeSecret).tokenUrl === "string",
  { errors: null },
);

function tokenExchange() {
  return defineAuth({
    validateSecret: isExchangeSecret,
    headers: ["authorization"],
    create: ({ secret, transport }) => {
      interface Token {
        readonly value: string;
        readonly expiresAt: number;
      }
      let token: Token | undefined;
      let inflight: Promise<Token> | undefined;

      async function exchange(signal: AbortSignal): Promise<Token> {
        const { clientId, clientSecret, tokenUrl } = await secret.get();
        const response = await transport.request(
          {
            method: "POST",
            url: tokenUrl,
            form: {
              grant_type: "client_credentials",
              client_id: clientId,
              client_secret: clientSecret,
            },
          },
          signal,
        );
        if (response.status !== 200) {
          throw new GatewayError(
            "UPSTREAM_REJECTED",
            `Token endpoint returned ${response.status}`,
          );
        }
        const body = response.json() as {
          access_token: string;
          expires_in: number;
        };
        return {
          value: body.access_token,
          expiresAt: Date.now() + body.expires_in * 1_000,
        };
      }

      return {
        async headers({ signal }) {
          if (token === undefined || token.expiresAt <= Date.now()) {
            inflight ??= exchange(signal).finally(() => {
              inflight = undefined;
            });
            token = await inflight;
          }
          return { authorization: `Bearer ${token.value}` };
        },
      };
    },
  });
}

describe("a custom token exchange", () => {
  const TOKEN_URL = "https://idp.test/oauth/token";
  const CLIENT = {
    clientId: "gateway",
    clientSecret: "SYNTHETIC_CLIENT_SECRET",
    tokenUrl: TOKEN_URL,
  };

  function idp(
    respondToken: () => Response | Promise<Response> = () =>
      json(200, { access_token: "T1", expires_in: 3600 }),
  ) {
    const ff = fakeFetch((req) =>
      req.url === TOKEN_URL ? respondToken() : json(200, {}),
    );
    const tokenCalls = () => ff.calls.filter((c) => c.url === TOKEN_URL);
    const opCalls = () => ff.calls.filter((c) => c.url !== TOKEN_URL);
    return { ff, tokenCalls, opCalls };
  }

  it("exchanges the secret for a token once and reuses it", async () => {
    const { ff, tokenCalls, opCalls } = idp();
    const execute = await buildExecutor(
      gatewayWith(tokenExchange()),
      { target: TARGET, secret: fakeSecret(CLIENT).provider },
      { fetch: ff.fetch },
    );
    // Creating the executor validates the secret but exchanges nothing.
    expect(ff.calls).toHaveLength(0);

    await execute(passthroughContext(), "op", {});
    await execute(passthroughContext(), "op", {});
    expect(tokenCalls()).toHaveLength(1);
    expect(tokenCalls()[0]?.init.body).toBe(
      "grant_type=client_credentials&client_id=gateway&client_secret=SYNTHETIC_CLIENT_SECRET",
    );
    expect(opCalls().map((c) => headerOf(c, "authorization"))).toEqual([
      "Bearer T1",
      "Bearer T1",
    ]);
  });

  it("shares one exchange between concurrent requests", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { ff, tokenCalls, opCalls } = idp(async () => {
      await gate;
      return json(200, { access_token: "T1", expires_in: 3600 });
    });
    const execute = await buildExecutor(
      gatewayWith(tokenExchange()),
      { target: TARGET, secret: fakeSecret(CLIENT).provider },
      { fetch: ff.fetch },
    );
    const requests = Promise.all([
      execute(passthroughContext(), "op", {}),
      execute(passthroughContext(), "op", {}),
    ]);
    await vi.waitFor(() => expect(tokenCalls()).toHaveLength(1));
    release();
    await requests;
    expect(tokenCalls()).toHaveLength(1);
    expect(opCalls().map((c) => headerOf(c, "authorization"))).toEqual([
      "Bearer T1",
      "Bearer T1",
    ]);
  });

  it("exchanges again when the token expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let issued = 0;
      const { ff, tokenCalls } = idp(() =>
        json(200, { access_token: `T${(issued += 1)}`, expires_in: 60 }),
      );
      const execute = await buildExecutor(
        gatewayWith(tokenExchange()),
        { target: TARGET, secret: fakeSecret(CLIENT).provider },
        { fetch: ff.fetch },
      );
      await execute(passthroughContext(), "op", {});
      vi.setSystemTime(59_000);
      await execute(passthroughContext(), "op", {});
      expect(tokenCalls()).toHaveLength(1);
      vi.setSystemTime(60_000);
      await execute(passthroughContext(), "op", {});
      expect(tokenCalls()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a refused exchange without replaying anything", async () => {
    const { ff, tokenCalls, opCalls } = idp(() => json(401, {}));
    const execute = await buildExecutor(
      gatewayWith(tokenExchange()),
      { target: TARGET, secret: fakeSecret(CLIENT).provider },
      { fetch: ff.fetch },
    );
    await expect(execute(passthroughContext(), "op", {})).rejects.toMatchObject(
      { code: "UPSTREAM_REJECTED", message: "Token endpoint returned 401" },
    );
    expect(tokenCalls()).toHaveLength(1);
    expect(opCalls()).toHaveLength(0);
  });

  it("reduces a failing token endpoint to a controlled diagnostic", async () => {
    const { ff, opCalls } = idp(() => {
      throw Object.assign(new Error("SYNTHETIC_CLIENT_SECRET leaked"), {
        name: "SYNTHETIC_NAME",
      });
    });
    const execute = await buildExecutor(
      gatewayWith(tokenExchange()),
      { target: TARGET, secret: fakeSecret(CLIENT).provider },
      { fetch: ff.fetch },
    );
    const err = await rejection(execute(passthroughContext(), "op", {}));
    expect(err).toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "Upstream request failed for an authentication request: Error",
    });
    expect(err.message).not.toContain("SYNTHETIC");
    expect(opCalls()).toHaveLength(0);
  });

  it("resolves a token path against the upstream target", async () => {
    const ff = fakeFetch((req) =>
      req.url === "https://api.test/v1/oauth/token"
        ? json(200, { access_token: "T1", expires_in: 3600 })
        : json(200, {}),
    );
    const execute = await buildExecutor(
      gatewayWith(tokenExchange()),
      {
        target: "https://api.test/v1",
        secret: fakeSecret({ ...CLIENT, tokenUrl: "/oauth/token" }).provider,
      },
      { fetch: ff.fetch },
    );
    await execute(passthroughContext(), "op", {});
    expect(ff.calls.map((c) => c.url)).toEqual([
      "https://api.test/v1/oauth/token",
      "https://api.test/v1/x",
    ]);
  });
});

describe("execute", () => {
  async function setup(respond: Parameters<typeof fakeFetch>[0]) {
    const ff = fakeFetch(respond);
    const execute = await buildExecutor(
      gateway,
      { target: "https://api.test/v1", secret: emptySecret() },
      { fetch: ff.fetch },
    );
    return { execute, ff };
  }

  // Preparation happens inside execute, so a refused value must fail the whole call without a
  // request going out. Checking prepare alone would not show that nothing was sent.
  it.each(["a/b", "..", "", "%2e", "x\ud800y", "x\u0000y", "x\u007fy"])(
    "rejects the path value %j before sending anything",
    async (userId) => {
      const { execute, ff } = await setup(() => json(200, { id: "u1" }));
      const err = await rejection(
        execute(passthroughContext(), "getUser", { userId }),
      );
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).code).toBe("INTERNAL");
      expect(ff.calls).toHaveLength(0);
    },
  );

  it("runs the automatic mapping for an operation", async () => {
    const { execute, ff } = await setup(() => json(200, { id: "u1" }));
    const result = await execute(passthroughContext(), "getUser", {
      userId: "u1",
    });
    expect(result).toEqual({ outcome: "ok", data: { id: "u1" } });
    expect(ff.calls[0]?.url).toBe("https://api.test/v1/users/u1");
    expect(headerOf(ff.calls[0]!, "x-api-version")).toBe("2");
  });

  it("sends the payload as the body", async () => {
    const { execute, ff } = await setup(() => json(201, { id: "new" }));
    const result = await execute(passthroughContext(), "createUser", {
      payload: { email: "a@b.test" },
    });
    expect(result).toEqual({ outcome: "created", data: { id: "new" } });
    expect(ff.calls[0]?.init.body).toBe('{"email":"a@b.test"}');
  });

  it("dispatches to the operation's handler", async () => {
    const { execute, ff } = await setup(() => json(200, {}));
    const result = await execute(passthroughContext(), "custom", { id: "c1" });
    expect(result).toEqual({ outcome: "custom", data: { status: 200 } });
    expect(ff.calls[0]?.url).toBe("https://api.test/v1/custom/c1");
    expect(headerOf(ff.calls[0]!, "x-custom")).toBe("yes");
  });

  it("throws for an operation it was not built with", async () => {
    const { execute } = await setup(() => json(200, {}));
    await expect(execute(passthroughContext(), "unknown", {})).rejects.toThrow(
      /Unknown operation "unknown"/,
    );
  });

  it("uses the global fetch by default", async () => {
    const execute = await createExecutor(gatewayWith(noAuth()), {
      target: "http://127.0.0.1:1",
      secret: emptySecret(),
    });
    await expect(execute(passthroughContext(), "op", {})).rejects.toMatchObject(
      { code: "UPSTREAM_ERROR" },
    );
  });
});

describe("through the runtime handler", () => {
  let stdout: string[] = [];

  beforeEach(() => {
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const requireId: Validator = Object.assign(
    (data: unknown): data is { id: string } =>
      typeof data === "object" &&
      data !== null &&
      typeof (data as { id?: unknown }).id === "string",
    { errors: null },
  );

  const validators = {
    getUser: { input: accept, outcomes: { ok: requireId } },
    createUser: { input: accept, outcomes: { created: requireId } },
    custom: { input: accept, outcomes: { custom: accept } },
  };

  async function handlerWith(
    respond: Parameters<typeof fakeFetch>[0],
    options: {
      auth?: OpenApiRestAuth;
      secret?: SecretProvider;
      fetch?: typeof fetch;
      policy?: { upstreamTimeout?: string };
    } = {},
  ) {
    const config = {
      ...gateway,
      driver: openapiRest({
        spec: SPEC,
        auth: options.auth ?? noAuth(),
        headers: { "x-api-version": "2" },
      }),
      policy: { ...gateway.policy, ...options.policy },
    };
    const execute = await buildExecutor(
      config,
      { target: TARGET, secret: options.secret ?? emptySecret() },
      { fetch: options.fetch ?? fakeFetch(respond).fetch },
    );
    const handle = createHandler(config, { validators, execute });
    return (event: unknown) =>
      handle(event, { deadline: { remainingMs: () => 5_000 } });
  }

  const envelope = (operation: string, input: unknown) => ({
    operation,
    input,
    secure: { values: {}, signature: "" },
  });

  const never = () => new Promise<never>(() => undefined);

  it("returns a success envelope", async () => {
    const handle = await handlerWith(() => json(200, { id: "u1" }));
    await expect(
      handle(envelope("getUser", { userId: "u1" })),
    ).resolves.toEqual({ ok: true, outcome: "ok", data: { id: "u1" } });
  });

  it("returns the mapped error code for an upstream 404", async () => {
    const handle = await handlerWith(() => json(404, {}));
    await expect(
      handle(envelope("getUser", { userId: "secret-id" })),
    ).resolves.toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    // The diagnostic names the template, never the resolved path.
    const logged = stdout.join("");
    expect(logged).toContain("(GET /users/{id})");
    expect(logged).not.toContain("secret-id");
  });

  it("fails outcome validation when the body does not match the schema", async () => {
    const handle = await handlerWith(() => json(200, { nope: true }));
    await expect(
      handle(envelope("getUser", { userId: "u1" })),
    ).resolves.toEqual({
      ok: false,
      error: { code: "UPSTREAM_CONTRACT_VIOLATION" },
    });
  });

  it("times out through the driver context", async () => {
    const handle = await handlerWith(() => json(200, {}), {
      fetch: (_input, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      policy: { upstreamTimeout: "20ms" },
    });
    await expect(
      handle(envelope("getUser", { userId: "u1" })),
    ).resolves.toEqual({ ok: false, error: { code: "UPSTREAM_TIMEOUT" } });
  });

  it("times out a secret refresh that never resolves", async () => {
    const secret = fakeSecret({ token: "tok" });
    const handle = await handlerWith(() => json(200, { id: "u1" }), {
      auth: bearerToken(),
      secret: secret.provider,
      policy: { upstreamTimeout: "20ms" },
    });
    secret.provider.get = never;
    await expect(
      handle(envelope("getUser", { userId: "u1" })),
    ).resolves.toEqual({ ok: false, error: { code: "UPSTREAM_TIMEOUT" } });
  });

  it("times out a token exchange that never answers", async () => {
    const handle = await handlerWith(
      (req) =>
        req.url === "https://idp.test/token"
          ? never()
          : json(200, { id: "u1" }),
      {
        auth: tokenExchange(),
        secret: fakeSecret({
          clientId: "c",
          clientSecret: "SYNTHETIC",
          tokenUrl: "https://idp.test/token",
        }).provider,
        policy: { upstreamTimeout: "20ms" },
      },
    );
    await expect(
      handle(envelope("getUser", { userId: "u1" })),
    ).resolves.toEqual({ ok: false, error: { code: "UPSTREAM_TIMEOUT" } });
    expect(stdout.join("")).not.toContain("SYNTHETIC");
  });

  it("keeps a failing authentication flow out of the logs", async () => {
    const failing = defineAuth({
      validateSecret: accept,
      headers: ["authorization"],
      create: () => ({
        headers: () => {
          throw Object.assign(new Error("token=SYNTHETIC_MESSAGE"), {
            name: "SYNTHETIC_NAME_SECRET",
            request: { headers: { authorization: "SYNTHETIC_PROPERTY" } },
            cause: new Error("SYNTHETIC_CAUSE"),
          });
        },
      }),
    });
    const handle = await handlerWith(() => json(200, { id: "u1" }), {
      auth: failing,
    });
    await expect(
      handle(envelope("getUser", { userId: "u1" })),
    ).resolves.toEqual({ ok: false, error: { code: "INTERNAL" } });
    const logged = stdout.join("");
    // pino escapes the quotes around the operation name in its JSON line.
    expect(logged).toContain("Authentication failed for operation");
    expect(logged).not.toMatch(/SYNTHETIC_/);
  });

  it("keeps an invalid replacement secret out of the logs", async () => {
    const secret = fakeSecret({ token: "tok" });
    const handle = await handlerWith(() => json(200, { id: "u1" }), {
      auth: bearerToken(),
      secret: secret.provider,
    });
    secret.rotate({ token: "SYNTHETIC_TOKEN\n" });
    await expect(
      handle(envelope("getUser", { userId: "u1" })),
    ).resolves.toEqual({ ok: false, error: { code: "INTERNAL" } });
    const logged = stdout.join("");
    expect(logged).toContain("failed validation at #/properties/token");
    expect(logged).not.toContain("SYNTHETIC_TOKEN");
  });

  it("reports a failed refresh with the provider's diagnostic", async () => {
    const secret = fakeSecret({ token: "tok" });
    const handle = await handlerWith(() => json(200, { id: "u1" }), {
      auth: bearerToken(),
      secret: secret.provider,
    });
    secret.fail(
      new GatewayError("INTERNAL", "Failed to retrieve gateway secret"),
    );
    await expect(
      handle(envelope("getUser", { userId: "u1" })),
    ).resolves.toEqual({ ok: false, error: { code: "INTERNAL" } });
    expect(stdout.join("")).toContain("Failed to retrieve gateway secret");
  });

  it("keeps an unlisted transport error name and code out of the logs", async () => {
    const handle = await handlerWith(() => {
      throw Object.assign(new Error("SYNTHETIC_MESSAGE"), {
        name: "SYNTHETIC_NAME_SECRET",
        cause: Object.assign(new Error("x"), { code: "SYNTHETIC_CODE" }),
      });
    });
    await expect(
      handle(envelope("getUser", { userId: "u1" })),
    ).resolves.toEqual({ ok: false, error: { code: "UPSTREAM_ERROR" } });
    expect(stdout.join("")).not.toMatch(/SYNTHETIC_/);
  });

  it("keeps an invalid mapped header value out of the logs", async () => {
    const handle = await handlerWith(() => json(200, { id: "u1" }));
    await expect(
      handle(
        envelope("getUser", {
          userId: "u1",
          token: "SYNTHETIC_SECRET_123\ninvalid",
        }),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "INTERNAL" } });
    const logged = stdout.join("");
    expect(logged).toContain("has an invalid value");
    expect(logged).not.toContain("SYNTHETIC_SECRET_123");
  });

  it("keeps the names of unmapped input fields out of the logs", async () => {
    const handle = await handlerWith(() => json(200, { id: "u1" }));
    await expect(
      handle(envelope("getUser", { userId: "u1", SYNTHETIC_FIELD: "x" })),
    ).resolves.toEqual({ ok: false, error: { code: "INTERNAL" } });
    const logged = stdout.join("");
    expect(logged).toContain("1 input field is not mapped");
    expect(logged).not.toContain("SYNTHETIC_FIELD");
  });

  it("keeps a traversal-shaped path value out of the logs", async () => {
    const handle = await handlerWith(() => json(200, { id: "u1" }));
    await expect(
      handle(envelope("getUser", { userId: "../../SYNTHETIC_ADMIN" })),
    ).resolves.toEqual({ ok: false, error: { code: "INTERNAL" } });
    expect(stdout.join("")).not.toContain("SYNTHETIC_ADMIN");
  });

  it("surfaces a mapping bug as INTERNAL", async () => {
    const handle = await handlerWith(() => json(200, { id: "u1" }));
    await expect(
      handle(envelope("getUser", { userId: "u1", stray: 1 })),
    ).resolves.toEqual({ ok: false, error: { code: "INTERNAL" } });
  });
});
