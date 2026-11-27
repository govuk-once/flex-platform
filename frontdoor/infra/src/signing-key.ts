import { sortedNames } from "@repo/utils/sorted-names";
import { RemovalPolicy } from "aws-cdk-lib";
import { AnyPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Alias, Key } from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

import { exactRoleArn } from "./exact-role-arn.ts";
import { signingKeyAliasName } from "./names.ts";

export interface SigningKeyProps {
  readonly environment: string;
  /**
   * The roles, by ARN, that decrypt a private key with the key: the edge's. Each is named
   * exactly.
   */
  readonly decryptRoleArns: readonly string[];
  /** Key rotation's role, by ARN, named exactly: the one role that encrypts with the key. */
  readonly rotationRoleArn: string;
}

// Every way to a ciphertext under the key: a data key, a key pair, or one encrypted again.
const ENCRYPT_ACTIONS = [
  "kms:Encrypt",
  "kms:GenerateDataKey*",
  "kms:ReEncrypt*",
];

// Those of them rotation has no use for: all but making a key pair with no plaintext, and
// encrypting one again. Named one by one, since a statement can't hold an exception.
const ROTATION_DENIED_ACTIONS = [
  "kms:Encrypt",
  "kms:GenerateDataKey",
  "kms:GenerateDataKeyPair",
  "kms:GenerateDataKeyWithoutPlaintext",
];

/**
 * The KMS key that wraps the private keys the edge signs the caller token with. Key rotation makes
 * each key pair under it, and the edge decrypts the private key with it. Both find it by its
 * alias, since the key's ID is generated.
 *
 * Its policy says who may use it, whatever a principal's own policy allows: only the roles given
 * decrypt, only rotation's role encrypts, and nothing is encrypted again under another key. Each
 * is a deny, beside CDK's default statement, which leaves managing the key to IAM. So the policy
 * names no role a deploy runs as, denies nothing that manages the key, and can always be
 * rewritten. A role's own policy still has to allow what it does.
 *
 * Retained: a key that went with its stack would leave every encrypted signing key undecryptable,
 * and stop the edge.
 */
export class SigningKey extends Construct {
  public readonly key: Key;

  constructor(scope: Construct, id: string, props: SigningKeyProps) {
    super(scope, id);

    const decrypters = sortedNames(
      new Set(
        props.decryptRoleArns.map((arn) => exactRoleArn(arn, "decrypts")),
      ),
    );
    const rotation = exactRoleArn(props.rotationRoleArn, "rotates the keys");

    this.key = new Key(this, "Key", {
      description:
        "Wraps the private keys the edge signs the caller token with",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    new Alias(this, "Alias", {
      aliasName: signingKeyAliasName(props.environment),
      targetKey: this.key,
    });

    const deny = (sid: string, actions: string[], conditions?: object) =>
      this.key.addToResourcePolicy(
        new PolicyStatement({
          sid,
          effect: Effect.DENY,
          principals: [new AnyPrincipal()],
          actions,
          // The key itself: a key's policy names no other.
          resources: ["*"],
          ...(conditions !== undefined && { conditions }),
        }),
      );
    // With no role given, no one decrypts.
    deny(
      "DenyDecryptToAllButItsReaders",
      ["kms:Decrypt"],
      decrypters.length === 0
        ? undefined
        : { ArnNotLike: { "aws:PrincipalArn": decrypters } },
    );
    deny("DenyEncryptingToAllButKeyRotation", ENCRYPT_ACTIONS, {
      ArnNotLike: { "aws:PrincipalArn": [rotation] },
    });
    deny("DenyKeyRotationAllButItsWork", ROTATION_DENIED_ACTIONS, {
      ArnLike: { "aws:PrincipalArn": [rotation] },
    });
    // A private key encrypted again under another key would decrypt for whoever that key lets.
    // IfExists, so a request that doesn't say which key it is onto is refused too.
    deny("DenyReEncryptOntoAnotherKey", ["kms:ReEncrypt*"], {
      BoolIfExists: { "kms:ReEncryptOnSameKey": "false" },
    });
  }
}
