import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { callerTokenKeySet } from "./policy.ts";

const pair = generateKeyPairSync("ed25519");
const der = (key = pair.publicKey) =>
  new Uint8Array(key.export({ format: "der", type: "spki" }));
const privateKey = new Uint8Array([1]);

describe("callerTokenKeySet", () => {
  it("writes the JWK set gateways read, by key ID, each key with the times it signs between", () => {
    const set = callerTokenKeySet([
      {
        keyId: "20261113T120000Z",
        publicKey: der(),
        privateKey,
        activeFrom: 2,
      },
      {
        keyId: "20261106T120000Z",
        publicKey: der(),
        privateKey,
        activeFrom: 1,
        activeUntil: 2,
      },
    ]);
    const x = pair.publicKey.export({ format: "jwk" }).x;

    expect(JSON.parse(set)).toEqual({
      keys: [
        {
          kty: "OKP",
          crv: "Ed25519",
          alg: "EdDSA",
          use: "sig",
          kid: "20261106T120000Z",
          x,
          signsFrom: 1,
          signsUntil: 2,
        },
        {
          kty: "OKP",
          crv: "Ed25519",
          alg: "EdDSA",
          use: "sig",
          kid: "20261113T120000Z",
          x,
          signsFrom: 2,
        },
      ],
    });
    expect(set).not.toContain("privateKey");
  });

  it("refuses a key that isn't Ed25519", () => {
    const p256 = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey;
    expect(() =>
      callerTokenKeySet([
        {
          keyId: "20261106T120000Z",
          publicKey: der(p256),
          privateKey,
          activeFrom: 1,
        },
      ]),
    ).toThrow("The key 20261106T120000Z is not an Ed25519 key");
  });
});
