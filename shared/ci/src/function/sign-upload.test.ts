import { createHash, createHmac } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { BUNDLE, CONFIG, NOW } from "../../test/helpers.ts";
import { bundleKey } from "./bundle.ts";
import {
  createUploadSigner,
  credentialsFromEnvironment,
  UPLOAD_EXPIRES_SECONDS,
} from "./sign-upload.ts";

// Stand-ins, in the shape of a role's credentials.
const CREDENTIALS = {
  accessKeyId: "SYNTHETIC_ACCESS_KEY_ID",
  secretAccessKey: "SYNTHETIC_SECRET_ACCESS_KEY",
  sessionToken: "SYNTHETIC_SESSION_TOKEN/+=",
};

const HOST = "shared-domain-code-000000000000.s3.eu-west-2.amazonaws.com";

const KEY = bundleKey("example", BUNDLE.sha256);

// The hash, as S3 takes a checksum: the same bytes, in base64.
const CHECKSUM = Buffer.from(BUNDLE.sha256, "hex").toString("base64");

function signer() {
  return createUploadSigner({
    uploads: CONFIG.uploads,
    credentials: () => CREDENTIALS,
    now: () => NOW * 1000,
  });
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Signature Version 4, worked out here from its specification and not by the signer, over the
// request an upload makes: the address as given, and `headers` as the upload sends them.
function expectedSignature(
  url: URL,
  headers: Record<string, string>,
): string | undefined {
  const query = [...url.searchParams.entries()].filter(
    ([name]) => name !== "X-Amz-Signature",
  );
  const escape = (value: string) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  const canonicalQuery = query
    .map(([name, value]) => `${escape(name)}=${escape(value)}`)
    .sort((a, b) => (a < b ? -1 : 1))
    .join("&");
  const names = Object.keys(headers).sort((a, b) => (a < b ? -1 : 1));
  const canonicalRequest = [
    "PUT",
    url.pathname,
    canonicalQuery,
    ...names.map((name) => `${name}:${headers[name] ?? ""}`),
    "",
    names.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const date = url.searchParams.get("X-Amz-Date") ?? "";
  const scope = `${date.slice(0, 8)}/eu-west-2/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    date,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  const key = ["eu-west-2", "s3", "aws4_request"].reduce<Buffer>(
    (derived, part) => hmac(derived, part),
    hmac(`AWS4${CREDENTIALS.secretAccessKey}`, date.slice(0, 8)),
  );
  return hmac(key, stringToSign).toString("hex");
}

describe("createUploadSigner", () => {
  it("signs a PUT of the bundle's key in the bucket, good for five minutes", async () => {
    const upload = await signer()(KEY, BUNDLE);
    const url = new URL(upload.url);

    expect(url.origin).toBe(`https://${HOST}`);
    expect(url.pathname).toBe(`/example/bundle/${BUNDLE.sha256}.zip`);
    expect(UPLOAD_EXPIRES_SECONDS).toBe(300);
    expect(upload.expiresInSeconds).toBe(300);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${CREDENTIALS.accessKeyId}/20270115/eu-west-2/s3/aws4_request`,
      "X-Amz-Date": "20270115T080000Z",
      "X-Amz-Expires": "300",
      "X-Amz-Security-Token": CREDENTIALS.sessionToken,
    });
  });

  // What holds an upload to the bundle the pipeline described: S3 refuses a request whose signed
  // headers differ from the ones signed.
  it("signs the bundle's length, its hash and the refusal to replace an object", async () => {
    const upload = await signer()(KEY, BUNDLE);
    const url = new URL(upload.url);

    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;host;if-none-match;x-amz-checksum-sha256",
    );
    expect(upload.headers).toEqual({
      "if-none-match": "*",
      "x-amz-checksum-sha256": CHECKSUM,
    });
    // In the address, the checksum would be a parameter and not a header the upload must send.
    expect(url.searchParams.has("x-amz-checksum-sha256")).toBe(false);
  });

  it("gives the signature Signature Version 4 specifies for exactly that upload", async () => {
    const upload = await signer()(KEY, BUNDLE);
    const url = new URL(upload.url);
    const sentHeaders = {
      "content-length": String(BUNDLE.size),
      host: HOST,
      ...upload.headers,
    };

    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      expectedSignature(url, sentHeaders),
    );
    // Another length, another hash, or leave to replace an object, and the signature is another.
    for (const changed of [
      { "content-length": String(BUNDLE.size + 1) },
      { "x-amz-checksum-sha256": Buffer.alloc(32).toString("base64") },
      { "if-none-match": '"etag"' },
    ]) {
      expect(url.searchParams.get("X-Amz-Signature")).not.toBe(
        expectedSignature(url, { ...sentHeaders, ...changed }),
      );
    }
  });

  it("signs each bundle for its own key alone", async () => {
    const sign = signer();
    const other = { ...BUNDLE, sha256: "0".repeat(64) };

    const first = new URL((await sign(KEY, BUNDLE)).url);
    const second = new URL(
      (await sign(bundleKey("example", other.sha256), other)).url,
    );

    expect(second.pathname).toBe(`/example/bundle/${other.sha256}.zip`);
    expect(second.searchParams.get("X-Amz-Signature")).not.toBe(
      first.searchParams.get("X-Amz-Signature"),
    );
  });

  it("reads the credentials for each upload, since Lambda rotates them", async () => {
    let calls = 0;
    const sign = createUploadSigner({
      uploads: CONFIG.uploads,
      credentials: () => {
        calls += 1;
        return { ...CREDENTIALS, accessKeyId: `SYNTHETIC_KEY_${calls}` };
      },
      now: () => NOW * 1000,
    });

    const first = new URL((await sign(KEY, BUNDLE)).url);
    const second = new URL((await sign(KEY, BUNDLE)).url);

    expect(first.searchParams.get("X-Amz-Credential")).toContain(
      "SYNTHETIC_KEY_1/",
    );
    expect(second.searchParams.get("X-Amz-Credential")).toContain(
      "SYNTHETIC_KEY_2/",
    );
  });
});

describe("credentialsFromEnvironment", () => {
  const NAMES = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
  ] as const;
  const before = NAMES.map((name) => process.env[name]);

  afterEach(() => {
    NAMES.forEach((name, index) => {
      const value = before[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  });

  it("reads the role's credentials from the variables Lambda sets", () => {
    process.env.AWS_ACCESS_KEY_ID = CREDENTIALS.accessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = CREDENTIALS.secretAccessKey;
    process.env.AWS_SESSION_TOKEN = CREDENTIALS.sessionToken;

    expect(credentialsFromEnvironment()).toEqual(CREDENTIALS);
  });

  it.each(NAMES)("throws without %s, so the request fails closed", (name) => {
    process.env.AWS_ACCESS_KEY_ID = CREDENTIALS.accessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = CREDENTIALS.secretAccessKey;
    process.env.AWS_SESSION_TOKEN = CREDENTIALS.sessionToken;
    delete process.env[name];

    expect(() => credentialsFromEnvironment()).toThrow("credentials");
  });
});
