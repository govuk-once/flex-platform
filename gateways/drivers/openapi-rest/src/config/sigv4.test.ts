import { createHash, createHmac } from "node:crypto";

import { defineGateway } from "@repo/gateway-config";
import { describe, expect, it, vi } from "vitest";

import {
  fakeFetch,
  fakeSecret,
  json,
  passthroughContext,
} from "../../test/helpers.ts";
import { buildExecutor } from "../runtime/executor.ts";
import { isHttpMethod } from "../types.ts";
import type {
  OpenApiRestAuthRequest,
  OpenApiRestAuthTransport,
} from "./auth.ts";
import { apiKey } from "./auth.ts";
import { openapiRest } from "./definition.ts";
import { fromSecret, type SecretValues } from "./secret-field.ts";
import {
  type AssumedRole,
  type Credentials,
  sigV4,
  type SigV4Options,
  sigV4With,
} from "./sigv4.ts";

// The credentials and the moment of AWS's own published examples. Not a real key.
const EXAMPLE = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const AT = new Date("2015-08-30T12:36:00Z");

// A role the upstream's owner grants, and what assuming it returns. SYNTHETIC values, and no
// role or key of anyone's.
const ROLE_ARN = "arn:aws:iam::000000000000:role/SYNTHETIC-consumer";
const ROLE = {
  accessKeyId: "AKIDSYNTHETIC",
  secretAccessKey: "SYNTHETIC-SECRET-ACCESS-KEY",
  sessionToken: "SYNTHETIC-SESSION-TOKEN",
};

const ROLE_OPTIONS = {
  arn: fromSecret("roleArn"),
  sessionName: "test-session",
};

const transport: OpenApiRestAuthTransport = {
  request: () => Promise.reject(new Error("unused")),
};

// The secret's named fields as a part reads them, from fixed values.
function fields(values: Record<string, string>): {
  get(): Promise<SecretValues>;
} {
  return {
    get: () =>
      Promise.resolve({
        get: (field) =>
          Object.hasOwn(values, field.secretField)
            ? values[field.secretField]
            : undefined,
      }),
  };
}

const request = (
  overrides: Partial<OpenApiRestAuthRequest> & { url: URL },
): OpenApiRestAuthRequest => ({
  operation: "op",
  signal: new AbortController().signal,
  method: "GET",
  headers: new Headers(),
  body: undefined,
  ...overrides,
});

// Signing under the given service and region, as a role that assumes to the given credentials.
const signing = (
  credentials: Credentials = EXAMPLE,
  { service, region } = { service: "service", region: "us-east-1" },
) =>
  sigV4With(
    { service, region, role: ROLE_OPTIONS },
    { assumeRole: () => () => Promise.resolve(credentials), now: () => AT },
  ).create({ secret: fields({ roleArn: ROLE_ARN }), transport });

// Signature Version 4 worked through from its specification, with nothing of the signer's: the
// same answer from two implementations is what says either is right.
function bySpecification(
  { method, url, headers, body }: OpenApiRestAuthRequest,
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  },
  { service, region }: { service: string; region: string },
  at = "20150830T123600Z",
): string {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const hmac = (key: string | Buffer, text: string) =>
    createHmac("sha256", key).update(text).digest();
  const rfc3986 = (text: string) =>
    encodeURIComponent(text).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );

  // The query as it was sent, decoding escapes and nothing else: a "+" is a plus here, as it is
  // to AWS, so a space the transport wrote as "+" would be signed as one thing and read as
  // another. `searchParams` reads it as a form would, and could not tell.
  const query = url.search
    .slice(1)
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => {
      const [name = "", value = ""] = pair.split("=");
      return [decodeURIComponent(name), decodeURIComponent(value)] as const;
    });

  const date = at.slice(0, 8);
  const all = new Headers(headers);
  all.set("host", url.host);
  all.set("x-amz-date", at);
  if (credentials.sessionToken !== undefined) {
    all.set("x-amz-security-token", credentials.sessionToken);
  }
  const names = [...all.keys()].sort();
  const canonical = [
    method,
    url.pathname.split("/").map(rfc3986).join("/"),
    query
      .map(([name, value]) => `${rfc3986(name)}=${rfc3986(value)}`)
      .sort()
      .join("&"),
    ...names.map(
      (name) => `${name}:${(all.get(name) ?? "").trim().replace(/\s+/g, " ")}`,
    ),
    "",
    names.join(";"),
    sha(body ?? ""),
  ].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", at, scope, sha(canonical)].join("\n");
  const key = [date, region, service, "aws4_request"].reduce<string | Buffer>(
    (derived, part) => hmac(derived, part),
    `AWS4${credentials.secretAccessKey}`,
  );
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
}

// What a request went out as, with the signature's own headers taken off: the rest is what the
// signature is over, and the worked example puts back the ones it accounts for.
function asSent(sent: { url: string; init: RequestInit } | undefined) {
  const signed = new Headers(sent?.init.headers);
  const carried = new Headers(signed);
  for (const owned of [
    "authorization",
    "x-amz-content-sha256",
    "x-amz-date",
    "x-amz-security-token",
  ]) {
    carried.delete(owned);
  }
  const body = sent?.init.body;
  const method = sent?.init.method ?? "GET";
  if (!isHttpMethod(method)) throw new Error(`sent as ${method}`);
  return {
    signed,
    request: request({
      method,
      url: new URL(sent?.url ?? ""),
      headers: carried,
      body: typeof body === "string" ? body : undefined,
    }),
  };
}

// An API key part, read from the secret's "apiKey" field, as UDP and UNS send one.
function apiKeyPart() {
  return apiKey({ header: "x-api-key", key: fromSecret("apiKey") });
}

describe("sigV4", () => {
  it("signs AWS's own published example as AWS does", async () => {
    // "get-vanilla" from the Signature Version 4 test suite.
    const headers = await signing().headers(
      request({ url: new URL("https://example.amazonaws.com/") }),
    );

    expect(headers).toEqual({
      authorization:
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
      "x-amz-date": "20150830T123600Z",
    });
  });

  it("signs AWS's own published example with a query as AWS does", async () => {
    // "get-vanilla-query-order-key-case" from the same suite: the names are signed in order.
    const headers = await signing().headers(
      request({
        url: new URL(
          "https://example.amazonaws.com/?Param2=value2&Param1=value1",
        ),
      }),
    );

    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    );
  });

  it("signs the method, the address, the headers and the body, as the specification works them out", async () => {
    const credentials = { ...EXAMPLE, sessionToken: "SYNTHETIC-SESSION-TOKEN" };
    const options = { service: "execute-api", region: "eu-west-2" };
    const posted = request({
      method: "POST",
      url: new URL(
        "https://abc123.execute-api.eu-west-2.amazonaws.com/prod/v1/groups?pushID=p%201&b=2&a=1",
      ),
      headers: new Headers({
        accept: "application/json",
        "content-type": "application/json",
        "x-api-version": "2",
      }),
      body: '[{"Namespace":"n","Group":"g","Action":"JOIN"}]',
    });

    const headers = await signing(credentials, options).headers(posted);

    expect(headers).toEqual({
      authorization: bySpecification(posted, credentials, options),
      "x-amz-date": "20150830T123600Z",
      "x-amz-security-token": "SYNTHETIC-SESSION-TOKEN",
    });
    expect(headers.authorization).toContain(
      "SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token;x-api-version",
    );
  });

  it("signs a name the query repeats, and a path the address encodes", async () => {
    const options = { service: "execute-api", region: "eu-west-2" };
    // Both are canonicalised before they are signed: a segment is escaped again, so what the
    // path already encodes is signed as written, and a repeated name is signed as every value
    // it carries. Signing either as the transport does not send it is refused by the upstream.
    const sent = request({
      url: new URL(
        "https://abc123.execute-api.eu-west-2.amazonaws.com/prod/a%20b/c%2Fd?id=2&id=1&q=a%20b",
      ),
    });

    const headers = await signing(EXAMPLE, options).headers(sent);

    expect(headers.authorization).toBe(bySpecification(sent, EXAMPLE, options));
  });

  it("signs what the transport sends, as the role the secret names", async () => {
    const options = { service: "execute-api", region: "eu-west-2" };
    const assumed: AssumedRole[] = [];
    const ff = fakeFetch(() => json(200, { id: "u1" }));
    const gateway = defineGateway({
      id: "signed",
      driver: openapiRest({
        spec: "https://example.test/openapi.yml",
        auth: [
          sigV4With(
            {
              service: options.service,
              region: fromSecret("region"),
              role: {
                arn: fromSecret("consumerRoleArn"),
                externalId: fromSecret("externalId", { optional: true }),
                sessionName: "udp-consumer-session",
              },
            },
            {
              assumeRole: (role) => {
                assumed.push(role);
                return () => Promise.resolve(ROLE);
              },
            },
          ),
        ],
      }),
      operations: {
        getUser: {
          upstream: "GET /users/{id}",
          parameters: { id: { in: "path" } },
        },
      },
    });
    const execute = await buildExecutor(
      gateway,
      {
        target: "https://abc123.execute-api.eu-west-2.amazonaws.com/prod",
        // An upstream's own secret, holding fields no part reads.
        secret: fakeSecret({
          consumerRoleArn: ROLE_ARN,
          externalId: "SYNTHETIC-EXTERNAL-ID",
          region: "eu-west-2",
          apiAccountId: "000000000000",
        }).provider,
      },
      { fetch: ff.fetch },
    );

    await execute(passthroughContext(), "getUser", { id: "u 1" });

    expect(assumed).toEqual([
      {
        arn: ROLE_ARN,
        externalId: "SYNTHETIC-EXTERNAL-ID",
        sessionName: "udp-consumer-session",
        region: "eu-west-2",
      },
    ]);
    const { signed, request: sent } = asSent(ff.calls[0]);
    expect(signed.get("x-amz-security-token")).toBe(ROLE.sessionToken);
    expect(signed.get("authorization")).toBe(
      bySpecification(sent, ROLE, options, signed.get("x-amz-date") ?? ""),
    );
  });

  it("signs a body, a query, a key and the headers a gateway sets and maps, as the transport sends them", async () => {
    const options = { service: "execute-api", region: "eu-west-2" };
    const ff = fakeFetch(() => json(200, { id: "u1" }));
    const gateway = defineGateway({
      id: "signed",
      driver: openapiRest({
        spec: "https://example.test/openapi.yml",
        auth: [
          apiKeyPart(),
          sigV4With(
            {
              service: options.service,
              region: options.region,
              role: ROLE_OPTIONS,
            },
            { assumeRole: () => () => Promise.resolve(ROLE) },
          ),
        ],
        headers: { "x-api-version": "2" },
      }),
      operations: {
        updateUser: {
          upstream: "POST /users/{id}",
          parameters: {
            id: { in: "path" },
            q: { in: "query" },
            trace: { in: "header", name: "x-trace-id" },
          },
        },
      },
    });
    const execute = await buildExecutor(
      gateway,
      {
        target: "https://abc123.execute-api.eu-west-2.amazonaws.com/prod",
        secret: fakeSecret({ roleArn: ROLE_ARN, apiKey: "SYNTHETIC-KEY" })
          .provider,
      },
      { fetch: ff.fetch },
    );

    await execute(passthroughContext(), "updateUser", {
      id: "u1",
      // A space and a plus, which a form would write alike and a signature must not.
      q: "a b+c",
      trace: "t-1",
      payload: { name: "Zoë 🙂" },
    });

    const { signed, request: sent } = asSent(ff.calls[0]);
    expect(sent.url.search).toBe("?q=a%20b%2Bc");
    expect(sent.body).toBe('{"name":"Zoë 🙂"}');
    expect(signed.get("x-api-key")).toBe("SYNTHETIC-KEY");
    expect(signed.get("authorization")).toBe(
      bySpecification(sent, ROLE, options, signed.get("x-amz-date") ?? ""),
    );
    // The key is set before the signature, so the signature covers it.
    expect(signed.get("authorization")).toContain(
      "SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token;x-api-key;x-api-version;x-trace-id",
    );
  });

  it("hashes the body it is given, whatever a request claims the hash is", async () => {
    const url = new URL("https://example.amazonaws.com/things");
    const signed = (headers: Headers, body: string) =>
      signing().headers(request({ method: "POST", url, headers, body }));
    const claimed = new Headers({ "x-amz-content-sha256": "UNSIGNED-PAYLOAD" });

    // The claim is not what is signed: the same body signs the same way with it and without.
    expect((await signed(claimed, '{"a":1}')).authorization).toBe(
      (await signed(new Headers(), '{"a":1}')).authorization,
    );

    // And two bodies still sign differently, which is what the claim would have taken away.
    expect((await signed(claimed, '{"a":1}')).authorization).not.toBe(
      (await signed(claimed, '{"a":2}')).authorization,
    );
  });

  it("refuses a query name it could not put in the signature", async () => {
    // The signer canonicalises a query through an ordinary object, so this name would be left
    // out of the signature while the request still carried it, and the upstream would check a
    // signature over a query it did not receive.
    const url = new URL("https://example.amazonaws.com/things");
    url.searchParams.set("__proto__", "one");

    await expect(signing().headers(request({ url }))).rejects.toThrow(
      /a query parameter named "__proto__" cannot be signed/,
    );
  });

  it("signs for the services it signs correctly for, and no others", () => {
    const valid = { region: "eu-west-2", role: ROLE_OPTIONS };
    expect(() => sigV4({ service: "execute-api", ...valid })).not.toThrow();
    // S3 wants the payload hash in a header and its path left unnormalised; this does neither.
    for (const service of ["s3", "glacier"]) {
      expect(() => sigV4({ service, ...valid })).toThrow(
        /is not one this signs for \(execute-api\)/,
      );
    }
  });

  it("owns the headers a signature travels in, and reads the fields it is told to", () => {
    const externalId = fromSecret("externalId", { optional: true });
    const region = fromSecret("region");
    const definition = sigV4({
      service: "execute-api",
      region,
      role: { ...ROLE_OPTIONS, externalId },
    });

    expect(definition.headers).toEqual([
      "authorization",
      // The payload hash is a header a caller must not supply: the signer would sign that value
      // rather than the body, and "UNSIGNED-PAYLOAD" would sign every body alike.
      "x-amz-content-sha256",
      "x-amz-date",
      "x-amz-security-token",
    ]);
    expect(definition.fields).toEqual([ROLE_OPTIONS.arn, externalId, region]);
  });

  it("assumes a role once and holds its credentials until shortly before they expire", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const assume = vi.fn(() =>
        Promise.resolve({ ...ROLE, expiration: new Date(60 * 60 * 1000) }),
      );
      const instance = sigV4With(
        { service: "service", region: "us-east-1", role: ROLE_OPTIONS },
        { assumeRole: () => assume },
      ).create({ secret: fields({ roleArn: ROLE_ARN }), transport });
      expect(assume).not.toHaveBeenCalled();

      const url = new URL("https://example.amazonaws.com/");
      await instance.headers(request({ url }));
      await instance.headers(request({ url }));
      expect(assume).toHaveBeenCalledTimes(1);

      // Five minutes from expiry, it is assumed again rather than signing with what may lapse.
      vi.setSystemTime(55 * 60 * 1000 + 1);
      await instance.headers(request({ url }));
      expect(assume).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("assumes the role again after an assumption fails, rather than holding the failure", async () => {
    const assume = vi
      .fn<() => Promise<Credentials>>()
      .mockRejectedValueOnce(new Error("SYNTHETIC STS failure"))
      .mockResolvedValue(ROLE);
    const instance = sigV4With(
      { service: "service", region: "us-east-1", role: ROLE_OPTIONS },
      { assumeRole: () => assume },
    ).create({ secret: fields({ roleArn: ROLE_ARN }), transport });

    const url = new URL("https://example.amazonaws.com/");
    await expect(instance.headers(request({ url }))).rejects.toThrow();
    await expect(instance.headers(request({ url }))).resolves.toHaveProperty(
      "x-amz-security-token",
      ROLE.sessionToken,
    );
    expect(assume).toHaveBeenCalledTimes(2);
  });

  it("assumes the role again once the upstream has refused its credentials", async () => {
    const assume = vi.fn(() => Promise.resolve(ROLE));
    const instance = sigV4With(
      { service: "service", region: "us-east-1", role: ROLE_OPTIONS },
      { assumeRole: () => assume },
    ).create({ secret: fields({ roleArn: ROLE_ARN }), transport });

    const url = new URL("https://example.amazonaws.com/");
    await instance.headers(request({ url }));
    instance.refused?.();
    await instance.headers(request({ url }));
    expect(assume).toHaveBeenCalledTimes(2);
  });

  it("assumes the new role when the secret is rotated to another", async () => {
    const assumed: string[] = [];
    let current = ROLE_ARN;
    const instance = sigV4With(
      { service: "service", region: "us-east-1", role: ROLE_OPTIONS },
      {
        assumeRole: (role) => {
          assumed.push(role.arn);
          return () => Promise.resolve(ROLE);
        },
      },
    ).create({
      secret: {
        get: () =>
          Promise.resolve({
            get: (field) =>
              field.secretField === "roleArn" ? current : undefined,
          }),
      },
      transport,
    });

    const url = new URL("https://example.amazonaws.com/");
    await instance.headers(request({ url }));
    current = "arn:aws:iam::000000000000:role/SYNTHETIC-rotated";
    await instance.headers(request({ url }));
    expect(assumed).toEqual([ROLE_ARN, current]);
  });

  it("refuses a region from the secret that is not one, without quoting it", async () => {
    const instance = sigV4With(
      {
        service: "service",
        region: fromSecret("region"),
        role: ROLE_OPTIONS,
      },
      { assumeRole: () => () => Promise.resolve(ROLE) },
    ).create({
      secret: fields({ roleArn: ROLE_ARN, region: "SYNTHETIC REGION" }),
      transport,
    });

    await expect(
      instance.headers(request({ url: new URL("https://example.test/") })),
    ).rejects.toThrow(/^sigV4 auth: the secret's region is not a region name$/);
  });

  it.each<[string, SigV4Options, RegExp]>([
    [
      "a service it cannot name",
      { service: "", region: "eu-west-2", role: ROLE_OPTIONS },
      /service must be a name/,
    ],
    [
      "a region it cannot name",
      { service: "execute-api", region: "EU West", role: ROLE_OPTIONS },
      /region must be a name/,
    ],
    [
      "a session name STS would refuse",
      {
        service: "execute-api",
        region: "eu-west-2",
        role: { ...ROLE_OPTIONS, sessionName: "has space" },
      },
      /role.sessionName must be 2 to 64/,
    ],
  ])("refuses a configuration with %s", (_what, options, message) => {
    expect(() => sigV4(options)).toThrow(message);
  });

  it("refuses a role written into the configuration rather than named in the secret", () => {
    expect(() =>
      sigV4({
        service: "execute-api",
        region: "eu-west-2",
        // @ts-expect-error a role's ARN is read from the secret, never written here
        role: { arn: ROLE_ARN, sessionName: "test-session" },
      }),
    ).toThrow(/role.arn must name the secret field that holds it/);
  });

  it("refuses a configuration that names no region", () => {
    // @ts-expect-error region is required, and a configuration the compiler did not check is refused too
    expect(() => sigV4({ service: "execute-api", role: ROLE_OPTIONS })).toThrow(
      TypeError,
    );
  });
});
