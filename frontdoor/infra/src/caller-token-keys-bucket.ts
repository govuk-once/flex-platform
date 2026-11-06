import { PlatformBucket } from "@repo/infra-constructs";
import { sortedNames } from "@repo/utils/sorted-names";
import { Validations } from "aws-cdk-lib";
import { AccountPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

import { CALLER_TOKEN_KEYS_OBJECT } from "./names.ts";

export interface CallerTokenKeysBucketProps {
  /**
   * The bucket's name, from `callerTokenKeysBucketName`. A plain string, not the bucket's token:
   * key rotation bakes the same name into its function, and every gateway's network derives it.
   */
  readonly bucketName: string;
  /**
   * The roles that may read the public keys, by ARN, which may hold a wildcard: in each domain
   * account, a pattern every gateway's role matches.
   */
  readonly readerRoles: readonly string[];
}

/**
 * The one place the caller token's public keys are kept, in the frontdoor account, where key
 * rotation writes them. Every gateway reads them from here, across accounts, through its network's
 * S3 endpoint, so a key is in every gateway's reach the moment it is written.
 *
 * Only the gateways' roles may read the object, and nothing else in it. Rotation writes it with its
 * own role's grant, in this account. Encrypted by S3, since a KMS key would need a grant for every
 * reader's account as well.
 */
export class CallerTokenKeysBucket extends Construct {
  public readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: CallerTokenKeysBucketProps) {
    super(scope, id);

    const { bucket } = new PlatformBucket(this, "Store", {
      bucketName: props.bucketName,
    });
    this.bucket = bucket;

    const readerRoles = sortedNames(new Set(props.readerRoles));
    if (readerRoles.length > 0) {
      // By account, held to the roles by condition: a role named as a principal must exist when
      // the policy is written, and a gateway's stack may not have been deployed yet.
      const accounts = sortedNames(
        new Set(readerRoles.map((arn) => arn.split(":")[4] ?? "")),
      );
      bucket.addToResourcePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          principals: accounts.map((account) => new AccountPrincipal(account)),
          actions: ["s3:GetObject"],
          resources: [bucket.arnForObjects(CALLER_TOKEN_KEYS_OBJECT)],
          conditions: { ArnLike: { "aws:PrincipalArn": readerRoles } },
        }),
      );
    }

    Validations.of(bucket).acknowledge({
      id: "AwsSolutions-S1",
      reason:
        "The bucket holds one object of public keys, which key rotation writes and gateways read. CloudTrail data events, not access logs, are where reads of it would be recorded.",
    });
  }
}
