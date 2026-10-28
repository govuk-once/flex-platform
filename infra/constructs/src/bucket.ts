import { type Duration, RemovalPolicy } from "aws-cdk-lib";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectLockRetention,
} from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

import { MINIMUM_TLS_VERSION } from "./validation/bucket-https-check.ts";

export interface PlatformBucketProps {
  /** Retained by default. An empty bucket, such as a placeholder origin, may be destroyed. */
  readonly removalPolicy?: RemovalPolicy;
  /**
   * How long each version of an object is kept under Object Lock in compliance mode. Nobody, the
   * account's root user included, can delete a version or shorten its lock before then.
   */
  readonly lockedFor?: Duration;
}

/**
 * A bucket of the platform's: private, encrypted, versioned so an overwrite or delete can be
 * undone, and refusing, from anyone, any request over plain HTTP or TLS older than
 * `MINIMUM_TLS_VERSION`.
 */
export class PlatformBucket extends Construct {
  public readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: PlatformBucketProps = {}) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;
    if (
      props.lockedFor !== undefined &&
      removalPolicy !== RemovalPolicy.RETAIN
    ) {
      // A locked bucket can't be emptied, so deleting it would fail the stack's deletion.
      throw new Error(`${this.node.path}: a locked bucket must be retained`);
    }

    this.bucket = new Bucket(this, "Bucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: MINIMUM_TLS_VERSION,
      versioned: true,
      removalPolicy,
      ...(props.lockedFor === undefined
        ? {}
        : {
            objectLockEnabled: true,
            objectLockDefaultRetention: ObjectLockRetention.compliance(
              props.lockedFor,
            ),
          }),
    });
  }
}
