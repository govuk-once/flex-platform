// Rotation's ports, as AWS calls. DynamoDB and KMS in the function's own region, where the keys
// are made and kept, and S3 in the publication's bucket's.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GenerateDataKeyPairWithoutPlaintextCommand,
  KMSClient,
  ReEncryptCommand,
} from "@aws-sdk/client-kms";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type { KeyPolicy } from "./policy.ts";
import type { RotationPorts } from "./rotation.ts";
import { tablePorts } from "./store.ts";
import type { KeyRotationConfig, PublicationConfig } from "./types.ts";

// Every call is retried by the SDK, since each is safe to repeat: the object is overwritten whole,
// a transaction carries a token that makes a repeat of it answer as the first did, and a key pair
// made twice leaves the first unused.
const CLIENT = { maxAttempts: 3 } as const;

function publisher(
  publication: PublicationConfig,
): (document: string) => Promise<void> {
  const s3 = new S3Client({ ...CLIENT, region: publication.region });
  const object = {
    Bucket: publication.bucket,
    Key: publication.object,
    ExpectedBucketOwner: publication.account,
  };
  // Only what differs from what is there, so a quiet run adds no version. A read that fails for
  // any reason is a write: the write says why.
  return async (document) => {
    const current = await s3
      .send(new GetObjectCommand(object))
      .then(({ Body }) => Body?.transformToString("utf8"))
      .catch(() => undefined);
    if (current === document) return;
    await s3.send(
      new PutObjectCommand({
        ...object,
        Body: document,
        ContentType: "application/json",
      }),
    );
  };
}

export function awsPorts(
  config: KeyRotationConfig,
  policy: KeyPolicy,
  region: string,
): RotationPorts {
  const kms = new KMSClient({ ...CLIENT, region });
  const dynamodb = new DynamoDBClient({ ...CLIENT, region });
  const publish =
    config.publication === null ? undefined : publisher(config.publication);
  // The reader decrypts with the same context, so a ciphertext only ever decrypts as the key it was
  // made as.
  const context = (keyId: string) => ({ purpose: policy.purpose, kid: keyId });

  return {
    ...tablePorts(dynamodb, {
      privateKeys: config.privateKeysTable,
      publicKeys: config.publicKeysTable,
    }),

    async generate(keyId) {
      const { PublicKey, PrivateKeyCiphertextBlob } = await kms.send(
        new GenerateDataKeyPairWithoutPlaintextCommand({
          KeyId: config.keyAlias,
          KeyPairSpec: policy.keyPairSpec,
          EncryptionContext: context(keyId),
        }),
      );
      if (PublicKey === undefined || PrivateKeyCiphertextBlob === undefined) {
        throw new Error("KMS returned no key pair");
      }
      return { publicKey: PublicKey, privateKey: PrivateKeyCiphertextBlob };
    },

    // Rotation's role can't decrypt. Encrypting the key again, under the same KMS key and
    // context, makes KMS decrypt it without returning it. The result is thrown away.
    async check({ keyId, privateKey }) {
      await kms.send(
        new ReEncryptCommand({
          CiphertextBlob: privateKey,
          SourceKeyId: config.keyAlias,
          SourceEncryptionContext: context(keyId),
          DestinationKeyId: config.keyAlias,
          DestinationEncryptionContext: context(keyId),
        }),
      );
    },

    async publish(document) {
      if (publish === undefined) {
        throw new Error(`The ${config.kind} keys are not published`);
      }
      await publish(document);
    },
  };
}
