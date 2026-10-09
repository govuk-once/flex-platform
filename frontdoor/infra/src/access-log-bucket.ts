import { Duration, RemovalPolicy, Validations } from "aws-cdk-lib";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectLockMode,
  ObjectOwnership,
} from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface AccessLogBucketProps {
  /** Logs expire after this, and are under object lock until then. */
  readonly retention: Duration;
}

/**
 * CloudFront delivers standard logs through an ACL grant, so the bucket must accept ACLs, which
 * `OBJECT_WRITER` ownership allows, and it cannot deliver to a KMS encrypted bucket, so the
 * encryption is S3 managed.
 */
export class AccessLogBucket extends Construct {
  public readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: AccessLogBucketProps) {
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
        duration: props.retention,
      },
      lifecycleRules: [
        {
          id: "ExpireLogs",
          expiration: props.retention,
          noncurrentVersionExpiration: props.retention,
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
