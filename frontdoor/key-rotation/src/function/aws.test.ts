import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { awsPorts as kindPorts } from "./aws.ts";
import { CALLER_TOKEN_POLICY } from "./policy.ts";
import type { KeyRotationConfig, PublicationConfig } from "./types.ts";

const PUBLICATION: PublicationConfig = {
  bucket: "frontdoor-sandbox-keys-100000000002",
  account: "100000000002",
  object: "caller-token-keys.json",
  region: "eu-west-2",
};

const CONFIG: KeyRotationConfig = {
  kind: "caller-token",
  keyAlias: "alias/frontdoor-sandbox-caller-token",
  privateKeysTable: "frontdoor-sandbox-caller-token-private-keys",
  publicKeysTable: "frontdoor-sandbox-caller-token-public-keys",
  publication: PUBLICATION,
};

const awsPorts = (config: KeyRotationConfig, region: string) =>
  kindPorts(config, CALLER_TOKEN_POLICY, region);

interface Call {
  readonly target: string;
  readonly region: string;
  readonly body: Record<string, unknown>;
  readonly accessKey: string;
}

// One stand-in for KMS and S3: it answers by the request's target, or as S3 when it has
// none, and records each call with the region and access key it was signed for.
let server: Server;
let calls: Call[];
let objects: Map<string, string>;

const PUBLIC_KEY = generateKeyPairSync("ed25519").publicKey;

function read(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => resolve(body));
  });
}

beforeEach(async () => {
  calls = [];
  objects = new Map();
  server = createServer((request, response) => {
    void read(request).then((text) => {
      const authorization = request.headers.authorization ?? "";
      const [, accessKey = "", region = ""] =
        /Credential=([^/]+)\/\d+\/([^/]+)\//.exec(authorization) ?? [];
      const target = String(request.headers["x-amz-target"] ?? "");

      if (target === "") {
        // S3, addressed by path, since the endpoint is an address. It refuses a call that names
        // another account as the bucket's owner, as S3 does.
        const path = (request.url ?? "").split("?")[0] ?? "";
        if (request.headers["x-amz-expected-bucket-owner"] !== "100000000002") {
          response.statusCode = 403;
          response.setHeader("content-type", "application/xml");
          response.end("<Error><Code>AccessDenied</Code></Error>");
          return;
        }
        calls.push({
          target: `S3 ${String(request.method)} ${path}`,
          region,
          body: { text },
          accessKey,
        });
        if (request.method === "PUT") {
          objects.set(path, text);
          response.end();
          return;
        }
        const object = objects.get(path);
        if (object === undefined) {
          response.statusCode = 404;
          response.setHeader("content-type", "application/xml");
          response.end("<Error><Code>NoSuchKey</Code></Error>");
          return;
        }
        response.end(object);
        return;
      }

      const body = JSON.parse(text) as Record<string, unknown>;
      calls.push({ target, region, body, accessKey });
      response.setHeader("content-type", "application/x-amz-json-1.1");
      if (target === "TrentService.GenerateDataKeyPairWithoutPlaintext") {
        response.end(
          JSON.stringify({
            PublicKey: PUBLIC_KEY.export({
              format: "der",
              type: "spki",
            }).toString("base64"),
            PrivateKeyCiphertextBlob:
              Buffer.from("ciphertext").toString("base64"),
          }),
        );
      } else if (target === "TrentService.ReEncrypt") {
        if (
          body.CiphertextBlob !== Buffer.from("ciphertext").toString("base64")
        ) {
          response.statusCode = 400;
          response.end(
            JSON.stringify({ __type: "InvalidCiphertextException" }),
          );
          return;
        }
        response.end(JSON.stringify({ CiphertextBlob: body.CiphertextBlob }));
      } else {
        response.statusCode = 400;
        response.end(JSON.stringify({ __type: "UnknownOperation" }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  // A string only for a pipe or socket path, and null before it listens.
  assert(typeof address === "object" && address !== null);
  const { port } = address;
  vi.stubEnv("AWS_ENDPOINT_URL", `http://127.0.0.1:${String(port)}`);
  vi.stubEnv("AWS_ACCESS_KEY_ID", "SYNTHETIC_ROTATION");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "SYNTHETIC_SECRET");
  vi.stubEnv("AWS_SESSION_TOKEN", "SYNTHETIC_TOKEN");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise((resolve) => server.close(resolve));
});

describe("awsPorts", () => {
  it("makes an Ed25519 key pair, bound to its purpose and ID", async () => {
    const key = await awsPorts(CONFIG, "eu-west-2").generate(
      "20261106T120000Z",
    );

    expect(Buffer.from(key.publicKey)).toEqual(
      PUBLIC_KEY.export({ format: "der", type: "spki" }),
    );
    expect(Buffer.from(key.privateKey).toString()).toBe("ciphertext");
    expect(calls).toEqual([
      expect.objectContaining({
        target: "TrentService.GenerateDataKeyPairWithoutPlaintext",
        region: "eu-west-2",
        body: {
          KeyId: "alias/frontdoor-sandbox-caller-token",
          KeyPairSpec: "ECC_NIST_EDWARDS25519",
          EncryptionContext: {
            purpose: "flex-caller-token",
            kid: "20261106T120000Z",
          },
        },
      }),
    ]);
  });

  it("has KMS decrypt a key by encrypting it again, under the same key and context", async () => {
    const ports = awsPorts(CONFIG, "eu-west-2");
    const context = { purpose: "flex-caller-token", kid: "20261106T120000Z" };
    await ports.check({
      keyId: "20261106T120000Z",
      privateKey: new Uint8Array(Buffer.from("ciphertext")),
    });

    expect(calls).toEqual([
      expect.objectContaining({
        target: "TrentService.ReEncrypt",
        region: "eu-west-2",
        body: {
          CiphertextBlob: Buffer.from("ciphertext").toString("base64"),
          SourceKeyId: "alias/frontdoor-sandbox-caller-token",
          SourceEncryptionContext: context,
          DestinationKeyId: "alias/frontdoor-sandbox-caller-token",
          DestinationEncryptionContext: context,
        },
      }),
    ]);
  });

  it("fails the check of a key KMS can't decrypt, by AWS's name for it", async () => {
    const ports = awsPorts(CONFIG, "eu-west-2");
    await expect(
      ports.check({
        keyId: "20261106T120000Z",
        privateKey: new Uint8Array(Buffer.from("damaged")),
      }),
    ).rejects.toMatchObject({ name: "InvalidCiphertextException" });
  });

  it("writes the public keys to the bucket, in its region, and only when they changed", async () => {
    const ports = awsPorts(CONFIG, "eu-west-2");
    await ports.publish('{"keys":[]}');
    await ports.publish('{"keys":[]}');

    const path = "/frontdoor-sandbox-keys-100000000002/caller-token-keys.json";
    expect(objects.get(path)).toBe('{"keys":[]}');
    expect(calls.map(({ target, region }) => `${region} ${target}`)).toEqual([
      `eu-west-2 S3 GET ${path}`,
      `eu-west-2 S3 PUT ${path}`,
      `eu-west-2 S3 GET ${path}`,
    ]);
  });

  it("never reads or writes a bucket of the same name that another account owns", async () => {
    const ports = awsPorts(
      { ...CONFIG, publication: { ...PUBLICATION, account: "999999999999" } },
      "eu-west-2",
    );
    await expect(ports.publish('{"keys":[]}')).rejects.toThrow();
    expect(objects.size).toBe(0);
  });

  it("publishes nothing for a kind that has no publication", async () => {
    const ports = kindPorts(
      { ...CONFIG, publication: null },
      { ...CALLER_TOKEN_POLICY, publication: null },
      "eu-west-2",
    );
    await expect(ports.publish('{"keys":[]}')).rejects.toThrow(
      "The caller-token keys are not published",
    );
    expect(calls).toEqual([]);
  });
});
