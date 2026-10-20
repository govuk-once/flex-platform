import { createHash, createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRequestSigner,
  type Credentials,
  credentialsFromEnvironment,
  type RequestToSign,
  SIGNING_REGION,
} from "./sign.ts";

const CREDENTIALS: Credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  sessionToken: "session-token-example",
};

const AT = new Date("2026-10-15T12:36:00Z");
const AMZ_DATE = "20261015T123600Z";

const REQUEST: RequestToSign = {
  method: "POST",
  host: "udp.development.flex-domain00.once.service.gov.uk",
  path: "/v1/identity",
  querystring: "",
  headers: {
    "content-type": "application/json",
    "x-correlation-id": "1-6b49d200-97575440147627ab6e7b6276",
  },
  body: new TextEncoder().encode('{"name":"value"}'),
};

const sign = createRequestSigner(() => CREDENTIALS);

// The signature, computed from AWS's description of Signature Version 4 without the signer: the
// canonical request, the string to sign, and the derived key.
function expectedAuthorization(request: RequestToSign): string {
  const sha = (data: string | Uint8Array) =>
    createHash("sha256").update(data).digest("hex");
  const hmac = (key: string | Buffer, text: string) =>
    createHmac("sha256", key).update(text).digest();
  const rfc3986 = (text: string) =>
    encodeURIComponent(text).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );

  // API Gateway decodes a "+" as a space.
  const decode = (text: string) => decodeURIComponent(text.replace(/\+/g, " "));
  const query = request.querystring
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => {
      const [name = "", value = ""] = pair.split("=");
      return `${rfc3986(decode(name))}=${rfc3986(decode(value))}`;
    })
    .sort();
  const headers = new Map<string, string>([
    ...Object.entries(request.headers),
    ["host", request.host],
    ["x-amz-date", AMZ_DATE],
    ["x-amz-security-token", CREDENTIALS.sessionToken ?? ""],
  ]);
  const names = [...headers.keys()].sort();
  const canonical = [
    request.method,
    // Every service but S3 escapes each segment of the path as it was sent, again.
    request.path.split("/").map(rfc3986).join("/"),
    query.join("&"),
    ...names.map((name) => `${name}:${headers.get(name) ?? ""}`),
    "",
    names.join(";"),
    sha(request.body),
  ].join("\n");
  const scope = `${AMZ_DATE.slice(0, 8)}/${SIGNING_REGION}/execute-api/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", AMZ_DATE, scope, sha(canonical)].join(
    "\n",
  );
  const key = [
    AMZ_DATE.slice(0, 8),
    SIGNING_REGION,
    "execute-api",
    "aws4_request",
  ].reduce<string | Buffer>(
    (derived, part) => hmac(derived, part),
    `AWS4${CREDENTIALS.secretAccessKey}`,
  );
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${CREDENTIALS.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
}

describe("createRequestSigner", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: AT });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("signs for execute-api in the home region, as AWS describes it", async () => {
    expect(await sign(REQUEST)).toEqual({
      authorization: expectedAuthorization(REQUEST),
      "x-amz-date": AMZ_DATE,
      "x-amz-security-token": CREDENTIALS.sessionToken,
    });
  });

  it("puts the body's hash in the signature, so another body doesn't verify", async () => {
    const other = {
      ...REQUEST,
      body: new TextEncoder().encode('{"name":"other"}'),
    };

    const signed = await sign(other);

    expect(signed.authorization).toBe(expectedAuthorization(other));
    expect(signed.authorization).not.toBe((await sign(REQUEST)).authorization);
  });

  it("signs an empty body as the hash of nothing", async () => {
    const empty = { ...REQUEST, method: "GET", body: new Uint8Array() };

    expect((await sign(empty)).authorization).toBe(
      expectedAuthorization(empty),
    );
  });

  it("signs the path and query as AWS reads them", async () => {
    const escaped = {
      ...REQUEST,
      path: "/v1/a%20b",
      querystring: "b=2&a=x+y&a=1&flag",
    };

    expect((await sign(escaped)).authorization).toBe(
      expectedAuthorization(escaped),
    );
  });

  // What API Gateway canonicalised b=2&a=x+y&a=1&flag&s=%20z%2Fw as, in the SigV4 probe.
  it("signs a query as API Gateway reads it, with a plus as a space", async () => {
    const sent = { ...REQUEST, querystring: "b=2&a=x+y&a=1&flag&s=%20z%2Fw" };
    const canonical = {
      ...REQUEST,
      querystring: "a=1&a=x%20y&b=2&flag=&s=%20z%2Fw",
    };

    expect((await sign(sent)).authorization).toBe(
      (await sign(canonical)).authorization,
    );
  });

  it("puts no payload hash header on the request", async () => {
    expect(Object.keys(await sign(REQUEST))).not.toContain(
      "x-amz-content-sha256",
    );
  });

  it("refuses a query name the signer would leave out", async () => {
    await expect(
      sign({ ...REQUEST, querystring: "__proto__=1" }),
    ).rejects.toThrow(/__proto__/);
  });

  it("reads the role's credentials from the environment for each request", () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("AWS_SESSION_TOKEN", "token");

    expect(credentialsFromEnvironment()).toEqual({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "token",
    });
  });

  it("refuses to sign without credentials", () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");

    expect(() => credentialsFromEnvironment()).toThrow(/credentials/);
  });
});
