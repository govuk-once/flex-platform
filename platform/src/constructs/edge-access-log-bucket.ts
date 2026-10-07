import { Duration, RemovalPolicy } from "aws-cdk-lib";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectLockMode,
  ObjectOwnership,
} from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

import { applyCheckovSkips } from "./checkov.ts";

export interface EdgeAccessLogBucketProps {
  readonly retention: Duration;
  /** Retained buckets are also put under object lock for the retention period. */
  readonly retainOnDelete: boolean;
}

/**
 * CloudFront delivers standard logs through an ACL grant, so the bucket must accept ACLs, which
 * `OBJECT_WRITER` ownership allows, and it cannot deliver to a KMS encrypted bucket, so the
 * encryption is S3 managed.
 */
export class EdgeAccessLogBucket extends Construct {
  public readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: EdgeAccessLogBucketProps) {
    super(scope, id);

    const { retention, retainOnDelete } = props;

    this.bucket = new Bucket(this, "Bucket", {
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
      versioned: true,
      lifecycleRules: [
        {
          id: "ExpireLogs",
          expiration: retention,
          noncurrentVersionExpiration: retention,
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
      ...(retainOnDelete
        ? {
            removalPolicy: RemovalPolicy.RETAIN,
            objectLockEnabled: true,
            objectLockDefaultRetention: {
              mode: ObjectLockMode.GOVERNANCE,
              duration: retention,
            },
          }
        : {
            removalPolicy: RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
          }),
    });

    applyCheckovSkips(this.bucket, [
      {
        id: "CKV_AWS_18",
        comment:
          "This is the access log bucket; logging its own access would recurse",
      },
    ]);
  }
}
