import { ResourceCheck } from "./resource-check.ts";
import {
  attachedPolicyStatements,
  coversResources,
  getAtt,
  hasAction,
  isAnyone,
  type PolicyStatement,
  soleCondition,
} from "./template.ts";

export const BUCKET_HTTPS_RULE = "Flex-BucketHttps";

/** A bucket must refuse any request over plain HTTP, or over TLS older than this. */
export const MINIMUM_TLS_VERSION = 1.2;

/**
 * Fails synth on any bucket whose policy doesn't deny, to anyone, every request to the bucket and
 * its objects over plain HTTP or TLS older than `MINIMUM_TLS_VERSION`. Each denial must hold its
 * condition and no other, so neither can be narrowed to some requests or tied to the other.
 */
export class BucketHttpsCheck extends ResourceCheck {
  constructor() {
    super({
      name: BUCKET_HTTPS_RULE,
      description: `A bucket's policy must deny every request over plain HTTP or TLS older than ${String(MINIMUM_TLS_VERSION)}, from anyone, to the bucket and its objects.`,
      fix: "Create it with PlatformBucket from @repo/infra-constructs.",
      type: "AWS::S3::Bucket",
      faults: (_, logicalId, template) => {
        const bucketArn = getAtt(logicalId, "Arn");
        const denials = attachedPolicyStatements(
          template,
          logicalId,
          "AWS::S3::BucketPolicy",
          "Bucket",
        ).filter((statement) =>
          deniesEveryoneEverything(statement, [
            bucketArn,
            { "Fn::Join": ["", [bucketArn, "/*"]] },
          ]),
        );
        const plainHttp = denials.some(
          (statement) =>
            soleCondition(statement, "Bool", "aws:SecureTransport") === "false",
        );
        // Denying below a later version refuses more, which also meets the rule.
        const oldTls = denials.some(
          (statement) =>
            Number(
              soleCondition(statement, "NumericLessThan", "s3:TlsVersion"),
            ) >= MINIMUM_TLS_VERSION,
        );
        return plainHttp && oldTls ? [] : ["Policy"];
      },
    });
  }
}

function deniesEveryoneEverything(
  statement: PolicyStatement,
  resources: readonly unknown[],
): boolean {
  return (
    statement.Effect === "Deny" &&
    isAnyone(statement.Principal) &&
    hasAction(statement, "s3:*") &&
    coversResources(statement, resources)
  );
}
