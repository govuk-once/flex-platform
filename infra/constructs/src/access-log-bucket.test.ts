import { App, Stack, Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";

import { AccessLogBucket } from "./access-log-bucket.ts";

function build(nag = false): { app: App; template: Template } {
  const app = new App();
  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const stack = new Stack(app, "Test", {
    env: { account: "123456789012", region: "eu-west-2" },
  });
  new AccessLogBucket(stack, "Logs");
  return { app, template: Template.fromStack(stack) };
}

describe("AccessLogBucket", () => {
  it("has no unacknowledged cdk-nag finding", () => {
    const { app } = build(true);

    expect(() => app.synth()).not.toThrow();
  });

  it("accepts log delivery, refuses everything public and insecure, and is retained", () => {
    const { template } = build();

    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: {
        OwnershipControls: { Rules: [{ ObjectOwnership: "ObjectWriter" }] },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
            },
          ],
        },
        VersioningConfiguration: { Status: "Enabled" },
      },
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Action: "s3:*",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      },
    });
  });

  it("keeps logs for a year, under object lock, then expires them", () => {
    const { template } = build();

    template.hasResourceProperties("AWS::S3::Bucket", {
      ObjectLockEnabled: true,
      ObjectLockConfiguration: {
        ObjectLockEnabled: "Enabled",
        Rule: { DefaultRetention: { Mode: "GOVERNANCE", Days: 365 } },
      },
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            ExpirationInDays: 365,
            NoncurrentVersionExpiration: { NoncurrentDays: 365 },
          }),
        ],
      },
    });
  });
});
