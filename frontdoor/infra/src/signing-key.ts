import { RemovalPolicy } from "aws-cdk-lib";
import { Alias, Key } from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

import { signingKeyAliasName } from "./names.ts";

export interface SigningKeyProps {
  readonly environment: string;
}

/**
 * The KMS key that wraps the private keys the edge signs the caller token with. Key rotation makes
 * each key pair under it, and the edge decrypts the private key with it. Both find it by its
 * alias, since the key's ID is generated.
 *
 * Retained: a key that went with its stack would leave every encrypted signing key undecryptable,
 * and stop the edge.
 */
export class SigningKey extends Construct {
  public readonly key: Key;

  constructor(scope: Construct, id: string, { environment }: SigningKeyProps) {
    super(scope, id);

    this.key = new Key(this, "Key", {
      description:
        "Wraps the private keys the edge signs the caller token with",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    new Alias(this, "Alias", {
      aliasName: signingKeyAliasName(environment),
      targetKey: this.key,
    });
  }
}
