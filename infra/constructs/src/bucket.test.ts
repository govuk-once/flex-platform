import { RemovalPolicy, Stack, Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";

import { PlatformBucket } from "./bucket.ts";
import { cdkApp } from "./cdk-app.ts";

function build(removalPolicy?: RemovalPolicy) {
  const app = cdkApp();
  const stack = new Stack(app, "Test", {
    env: { account: "123456789012", region: "eu-west-2" },
  });
  const { bucket } = new PlatformBucket(
    stack,
    "Store",
    removalPolicy === undefined ? {} : { removalPolicy },
  );
  return { app, bucket, template: Template.fromStack(stack) };
}

const BUCKET_ARN = {
  "Fn::GetAtt": [Match.stringLikeRegexp("^StoreBucket"), "Arn"],
};
const BUCKET_AND_OBJECTS = [
  BUCKET_ARN,
  { "Fn::Join": ["", [BUCKET_ARN, "/*"]] },
];

describe("PlatformBucket", () => {
  it.each([
    ["plain HTTP", { Bool: { "aws:SecureTransport": "false" } }],
    ["TLS older than 1.2", { NumericLessThan: { "s3:TlsVersion": 1.2 } }],
  ])("denies every request over %s, from anyone", (_, Condition) => {
    build().template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Effect: "Deny",
            Principal: { AWS: "*" },
            Action: "s3:*",
            Resource: BUCKET_AND_OBJECTS,
            Condition,
          },
        ]),
      },
    });
  });

  it("blocks public access and encrypts with S3's keys", () => {
    build().template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
    });
  });

  it("keeps every version of an object", () => {
    build().template.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
    });
  });

  it("is retained unless told otherwise", () => {
    build().template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
    });
    build(RemovalPolicy.DESTROY).template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Delete",
    });
  });

  // Access logging depends on what the bucket holds, so its user decides.
  it("has no other cdk-nag finding", () => {
    const { app, bucket } = build();
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    Validations.of(bucket).acknowledge({
      id: "AwsSolutions-S1",
      reason: "A test bucket, which never deploys.",
    });

    expect(() => app.synth()).not.toThrow();
  });
});
