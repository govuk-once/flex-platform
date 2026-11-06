import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { awsPorts } from "./aws.ts";
import type { KeyRotationConfig } from "./types.ts";

const CONFIG: KeyRotationConfig = {
  keyAlias: "alias/frontdoor-sandbox-caller-token",
  signingKeyParameter: "/flex/frontdoor/sandbox/caller-token-signing-key",
  stateParameter: "/flex/frontdoor/sandbox/caller-token-key-state",
  publicKeysBucket: "frontdoor-sandbox-keys-100000000002",
  publicKeysAccount: "100000000002",
  publicKeysObject: "caller-token-keys.json",
  publicKeysRegion: "eu-west-2",
};

interface Call {
  readonly target: string;
  readonly region: string;
  readonly body: Record<string, unknown>;
  readonly accessKey: string;
}

// One stand-in for KMS, SSM and S3: it answers by the request's target, or as S3 when it has
// none, and records each call with the region and access key it was signed for.
let server: Server;
let calls: Call[];
let parameters: Map<string, string>;
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
  parameters = new Map();
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
      if (target === "AmazonSSM.GetParameter") {
        const value = parameters.get(String(body.Name));
        if (value === undefined) {
          response.statusCode = 400;
          response.end(JSON.stringify({ __type: "ParameterNotFound" }));
          return;
        }
        response.end(JSON.stringify({ Parameter: { Value: value } }));
      } else if (target === "AmazonSSM.PutParameter") {
        parameters.set(`${region} ${String(body.Name)}`, String(body.Value));
        parameters.set(String(body.Name), String(body.Value));
        response.end(JSON.stringify({ Version: 1 }));
      } else if (
        target === "TrentService.GenerateDataKeyPairWithoutPlaintext"
      ) {
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
      } else {
        response.statusCode = 400;
        response.end(JSON.stringify({ __type: "UnknownOperation" }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
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
  it("reads no state as empty, and reads back the state it writes", async () => {
    const ports = awsPorts(CONFIG, "eu-west-2");
    expect(await ports.readState()).toEqual({ keys: [], revoked: [] });

    const state = {
      keys: [
        {
          kid: "20261106T120000Z",
          x: "AAAA",
          privateKey: "AQID",
          signsFrom: 1_793_102_400,
        },
      ],
      revoked: [{ kid: "20261106T110000Z", revokedAt: 1_793_098_800 }],
    };
    await ports.writeState(state);
    expect(await ports.readState()).toEqual(state);
    expect(calls.map(({ region }) => region)).toEqual([
      "eu-west-2",
      "eu-west-2",
      "eu-west-2",
    ]);
  });

  it("makes an Ed25519 key pair, bound to its purpose and ID", async () => {
    const key = await awsPorts(CONFIG, "eu-west-2").generate(
      "20261106T120000Z",
    );

    expect(key).toEqual({
      x: PUBLIC_KEY.export({ format: "jwk" }).x,
      privateKey: Buffer.from("ciphertext").toString("base64"),
    });
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
      { ...CONFIG, publicKeysAccount: "999999999999" },
      "eu-west-2",
    );
    await expect(ports.publish('{"keys":[]}')).rejects.toThrow();
    expect(objects.size).toBe(0);
  });

  it("writes the edge's signing keys, and only when they changed", async () => {
    const ports = awsPorts(CONFIG, "eu-west-2");
    const keys =
      '{"keys":[{"kid":"20261106T120000Z","privateKey":"AQID","signsFrom":1}]}';
    await ports.distribute(keys);
    await ports.distribute(keys);

    expect(
      parameters.get(
        "eu-west-2 /flex/frontdoor/sandbox/caller-token-signing-key",
      ),
    ).toBe(keys);
    expect(calls.map(({ target, region }) => `${region} ${target}`)).toEqual([
      "eu-west-2 AmazonSSM.GetParameter",
      "eu-west-2 AmazonSSM.PutParameter",
      "eu-west-2 AmazonSSM.GetParameter",
    ]);
  });
});
