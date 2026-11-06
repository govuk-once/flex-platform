// Rotation's ports, as AWS calls. SSM and KMS in the function's own region, where the keys are made
// and kept, and S3 in the public keys' bucket's.

import { createPublicKey } from "node:crypto";

import {
  GenerateDataKeyPairWithoutPlaintextCommand,
  KMSClient,
} from "@aws-sdk/client-kms";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { SIGNING_KEY_PURPOSE } from "@repo/frontdoor-shared";

import type { RotationPorts } from "./rotation.ts";
import { EMPTY_STATE, parseState } from "./state.ts";
import type { KeyRotationConfig } from "./types.ts";

// Every call is retried by the SDK, since each is safe to repeat: the parameters and the object are
// overwritten whole, and a key pair made twice leaves the first unused.
const CLIENT = { maxAttempts: 3 } as const;

// Every run writes what each reader should hold, but only what differs from what is there, so a
// quiet run adds no version. A read that fails for any reason is a write: the write says why.
async function writeIfChanged(
  value: string,
  read: () => Promise<string | undefined>,
  write: () => Promise<void>,
): Promise<void> {
  const current = await read().catch(() => undefined);
  if (current !== value) await write();
}

export function awsPorts(
  config: KeyRotationConfig,
  region: string,
): RotationPorts {
  const ssm = new SSMClient({ ...CLIENT, region });
  const kms = new KMSClient({ ...CLIENT, region });
  const s3 = new S3Client({ ...CLIENT, region: config.publicKeysRegion });

  async function put(name: string, value: string) {
    await ssm.send(
      new PutParameterCommand({
        Name: name,
        Value: value,
        Type: "String",
        Tier: "Standard",
        Overwrite: true,
      }),
    );
  }

  return {
    async readState() {
      try {
        const { Parameter } = await ssm.send(
          new GetParameterCommand({ Name: config.stateParameter }),
        );
        return parseState(Parameter?.Value ?? "");
      } catch (error) {
        if (error instanceof ParameterNotFound) return EMPTY_STATE;
        throw error;
      }
    },

    async writeState(state) {
      await put(config.stateParameter, JSON.stringify(state));
    },

    async generate(kid) {
      const { PublicKey, PrivateKeyCiphertextBlob } = await kms.send(
        new GenerateDataKeyPairWithoutPlaintextCommand({
          KeyId: config.keyAlias,
          KeyPairSpec: "ECC_NIST_EDWARDS25519",
          // The edge decrypts with the same context, so a ciphertext only ever decrypts as the
          // key it was made as.
          EncryptionContext: { purpose: SIGNING_KEY_PURPOSE, kid },
        }),
      );
      if (PublicKey === undefined || PrivateKeyCiphertextBlob === undefined) {
        throw new Error("KMS returned no key pair");
      }
      const { x } = createPublicKey({
        key: Buffer.from(PublicKey),
        format: "der",
        type: "spki",
      }).export({ format: "jwk" });
      if (x === undefined) throw new Error("KMS returned no Ed25519 key");
      return {
        x,
        privateKey: Buffer.from(PrivateKeyCiphertextBlob).toString("base64"),
      };
    },

    async publish(keySet) {
      const object = {
        Bucket: config.publicKeysBucket,
        Key: config.publicKeysObject,
        ExpectedBucketOwner: config.publicKeysAccount,
      };
      await writeIfChanged(
        keySet,
        async () => {
          const { Body } = await s3.send(new GetObjectCommand(object));
          return Body?.transformToString("utf8");
        },
        async () => {
          await s3.send(
            new PutObjectCommand({
              ...object,
              Body: keySet,
              ContentType: "application/json",
            }),
          );
        },
      );
    },

    async distribute(signingKeys) {
      await writeIfChanged(
        signingKeys,
        async () => {
          const { Parameter } = await ssm.send(
            new GetParameterCommand({ Name: config.signingKeyParameter }),
          );
          return Parameter?.Value;
        },
        () => put(config.signingKeyParameter, signingKeys),
      );
    },
  };
}
