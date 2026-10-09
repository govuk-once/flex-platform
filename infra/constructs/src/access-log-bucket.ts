import { Duration, RemovalPolicy, Validations } from "aws-cdk-lib";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectLockMode,
  ObjectOwnership,
} from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

/** Logs expire after this, and are under object lock until then. */
export const ACCESS_LOG_RETENTION = Duration.days(365);

/**
 * A bucket an AWS service delivers access logs to. Delivery is through an ACL grant, so the
 * bucket must accept ACLs, which `OBJECT_WRITER` ownership allows, and CloudFront cannot deliver
 * to a KMS encrypted bucket, so the encryption is S3 managed. The bucket outlives its stack.
 */
export class AccessLogBucket extends Construct {
  public readonly bucket: Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.bucket = new Bucket(this, "Bucket", {
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      objectLockEnabled: true,
      objectLockDefaultRetention: {
        mode: ObjectLockMode.GOVERNANCE,
        duration: ACCESS_LOG_RETENTION,
      },
      lifecycleRules: [
        {
          id: "ExpireLogs",
          expiration: ACCESS_LOG_RETENTION,
          noncurrentVersionExpiration: ACCESS_LOG_RETENTION,
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
    });

    Validations.of(this.bucket).acknowledge({
      id: "AwsSolutions-S1",
      reason:
        "This is the access log bucket; logging its own access would recurse.",
    });
  }
}
