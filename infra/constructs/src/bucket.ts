import { RemovalPolicy } from "aws-cdk-lib";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
} from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

import { MINIMUM_TLS_VERSION } from "./validation/bucket-https-check.ts";

export interface PlatformBucketProps {
  /** Retained by default. An empty bucket, such as a placeholder origin, may be destroyed. */
  readonly removalPolicy?: RemovalPolicy;
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

    this.bucket = new Bucket(this, "Bucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: MINIMUM_TLS_VERSION,
      versioned: true,
      removalPolicy: props.removalPolicy ?? RemovalPolicy.RETAIN,
    });
  }
}
