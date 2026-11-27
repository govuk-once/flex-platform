import { functionArn, PlatformBucket } from "@repo/infra-constructs";
import { UPLOAD_EXPIRES_SECONDS } from "@repo/shared-ci";
import { bundleKey } from "@repo/shared-release";
import { Validations } from "aws-cdk-lib";
import {
  AccountPrincipal,
  AnyPrincipal,
  Effect,
  PolicyStatement,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

/**
 * A domain account a release may load bundles into: the domain functions Lambda may read a bundle
 * for, and the deploy roles that release them, each a name pattern such as `domain-development-*`.
 */
export interface BundleReader {
  readonly account: string;
  readonly functionNames: string;
  readonly deployRoleNames: string;
}

export interface DomainCodeBucketProps {
  /** Named, since the pipeline API signs uploads to it by name. */
  readonly bucketName: string;
  /** The one role that may write to the bucket: the pipeline API's, which signs every upload. */
  readonly writerRoleArn: string;
  /** The domain accounts whose functions and deploy roles read bundles. */
  readonly readers: readonly BundleReader[];
}

/**
 * Where every domain's uploaded code is kept: one bundle per key, named by its domain and its own
 * hash, so a release finds the code it was given.
 *
 * The bucket's policy refuses, whoever asks, the account's own roles included:
 *
 * - a write by any role but the pipeline API's. A bundle's key is its hash only because the API
 *   signs each upload with that checksum, so a write it didn't sign could put other code under a
 *   bundle's key before the bundle is uploaded;
 * - a write that doesn't say to write only where there is no object (`If-None-Match`), so no
 *   bundle is replaced;
 * - a presigned request whose signature is older than an upload's address lasts, so the five
 *   minutes hold even if the pipeline API signs for longer;
 * - a delete of an object, or of a version of one;
 * - a change to the bucket's lifecycle rules. A rule that expires objects removes them with no
 *   delete request for the refusal above to see.
 *
 * So a bundle is kept for as long as this policy stands. The policy is no protection from
 * whoever may change the policy itself.
 *
 * It grants two reads of a bundle, by version. Lambda may read one for a domain's function: a
 * release has Lambda load a function's code from the bucket in place and keep no copy, so Lambda
 * reads the object again whenever it needs the code, and a function whose bundle is gone stops. A
 * domain's deploy role may read one, since Lambda reads the code a function is created or updated
 * from as the caller. The bucket names each reader by account and name pattern, never by domain,
 * so its policy grows with the accounts and not the domains: each deploy role's own policy holds
 * it to its domain's bundles. The pipeline API's and the release worker's roles are granted what
 * they do by their own policies.
 */
export class DomainCodeBucket extends Construct {
  public readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: DomainCodeBucketProps) {
    super(scope, id);

    const { bucket } = new PlatformBucket(this, "Store", {
      bucketName: props.bucketName,
    });
    this.bucket = bucket;

    bucket.addToResourcePolicy(
      new PolicyStatement({
        sid: "DenyWritesButThePipelineApi",
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ["s3:PutObject"],
        resources: [bucket.arnForObjects("*")],
        // A role's sessions, such as the one an upload was signed with, take the role's ARN here.
        conditions: {
          ArnNotEquals: { "aws:PrincipalArn": props.writerRoleArn },
        },
      }),
    );
    bucket.addToResourcePolicy(
      new PolicyStatement({
        sid: "DenyReplacingABundle",
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ["s3:PutObject"],
        resources: [bucket.arnForObjects("*")],
        // True when the request has no such header.
        conditions: { Null: { "s3:if-none-match": "true" } },
      }),
    );
    // As AWS's own guide to limiting presigned URLs has it: the age is in milliseconds, from the
    // signature's date, and only a presigned request's address carries its signature.
    bucket.addToResourcePolicy(
      new PolicyStatement({
        sid: "DenyStaleSignedAddresses",
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ["s3:*"],
        resources: [bucket.bucketArn, bucket.arnForObjects("*")],
        conditions: {
          StringEquals: { "s3:authType": "REST-QUERY-STRING" },
          NumericGreaterThan: {
            "s3:signatureAge": String(UPLOAD_EXPIRES_SECONDS * 1000),
          },
        },
      }),
    );
    bucket.addToResourcePolicy(
      new PolicyStatement({
        sid: "DenyDeletingABundle",
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
        resources: [bucket.arnForObjects("*")],
      }),
    );
    // On the bucket, which lifecycle rules belong to, not its objects. The bucket has no rules,
    // so this refuses nothing a deploy does.
    bucket.addToResourcePolicy(
      new PolicyStatement({
        sid: "DenyExpiringBundles",
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ["s3:PutLifecycleConfiguration"],
        resources: [bucket.bucketArn],
      }),
    );

    // As Lambda's own service, for a function in a domain account. The two conditions say which:
    // the function's ARN alone could name an account that isn't the platform's.
    props.readers.forEach(({ account, functionNames }, index) => {
      bucket.addToResourcePolicy(
        new PolicyStatement({
          sid: `LambdaReadsBundles${String(index)}`,
          effect: Effect.ALLOW,
          principals: [new ServicePrincipal("lambda.amazonaws.com")],
          actions: ["s3:GetObject", "s3:GetObjectVersion"],
          resources: [bucket.arnForObjects(bundleKey("*", "*"))],
          conditions: {
            StringEquals: { "aws:SourceAccount": account },
            ArnLike: {
              "aws:SourceArn": functionArn(this, functionNames, account),
            },
          },
        }),
      );
    });

    // As the account, on the role's ARN, as the deploy role's own trust names the worker: S3
    // refuses a policy naming a role that doesn't exist yet, and the domain stacks that create
    // the roles deploy after this one.
    if (props.readers.length > 0) {
      bucket.addToResourcePolicy(
        new PolicyStatement({
          sid: "DeployRolesReadBundles",
          effect: Effect.ALLOW,
          principals: props.readers.map(
            ({ account }) => new AccountPrincipal(account),
          ),
          actions: ["s3:GetObject", "s3:GetObjectVersion"],
          resources: [bucket.arnForObjects(bundleKey("*", "*"))],
          conditions: {
            ArnLike: {
              "aws:PrincipalArn": props.readers.map(
                ({ account, deployRoleNames }) =>
                  `arn:aws:iam::${account}:role/${deployRoleNames}`,
              ),
            },
          },
        }),
      );
    }

    Validations.of(bucket).acknowledge({
      id: "AwsSolutions-S1",
      reason:
        "Every object is written through an upload the pipeline API signed, and it logs each one. CloudTrail data events, not access logs, are where requests to the bucket would be recorded.",
    });
  }
}
