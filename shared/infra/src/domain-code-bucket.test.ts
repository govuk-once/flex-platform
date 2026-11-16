import { Match, Template } from "aws-cdk-lib/assertions";
import { assert, describe, expect, it } from "vitest";

import { ACCOUNT, appOf, stackIn } from "../test/helpers.ts";
import { DomainCodeBucket } from "./domain-code-bucket.ts";
import { domainCodeBucketName } from "./names.ts";

const NAME = domainCodeBucketName(ACCOUNT);
const WRITER = `arn:aws:iam::${ACCOUNT}:role/shared-ci`;

function build(nag = false) {
  const stack = stackIn("eu-west-2", nag);
  new DomainCodeBucket(stack, "Code", {
    bucketName: NAME,
    writerRoleArn: WRITER,
  });
  return stack;
}

function template(): Template {
  return Template.fromStack(build());
}

const OBJECTS = {
  "Fn::Join": ["", [{ "Fn::GetAtt": [Match.anyValue(), "Arn"] }, "/*"]],
};

describe("DomainCodeBucket", () => {
  it("passes cdk-nag and the platform's checks", () => {
    expect(() => appOf(build(true)).synth()).not.toThrow();
  });

  // Global, so it ends in the account's ID.
  it("is named for the shared account, within a bucket name's length", () => {
    expect(NAME).toBe(`shared-domain-code-${ACCOUNT}`);
    expect(NAME.length).toBeLessThanOrEqual(63);
  });

  it("is a bucket of the platform's: private, encrypted, versioned and retained", () => {
    template().hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: {
        BucketName: NAME,
        VersioningConfiguration: { Status: "Enabled" },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: Match.anyValue(),
      },
    });
  });

  // A bundle's key is its hash only because the pipeline API signs each upload with that
  // checksum, so nothing it didn't sign may write a key first.
  it("refuses a write from any role but the pipeline API's", () => {
    template().hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Sid: "DenyWritesButThePipelineApi",
            Effect: "Deny",
            Principal: { AWS: "*" },
            Action: "s3:PutObject",
            Resource: OBJECTS,
            Condition: { ArnNotEquals: { "aws:PrincipalArn": WRITER } },
          },
        ]),
      },
    });
  });

  // A release names a bundle by its key, so the object under a key must stay the one uploaded.
  it("refuses, from anyone, a write that doesn't say to write only where there is no object", () => {
    template().hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Sid: "DenyReplacingABundle",
            Effect: "Deny",
            Principal: { AWS: "*" },
            Action: "s3:PutObject",
            Resource: OBJECTS,
            Condition: { Null: { "s3:if-none-match": "true" } },
          },
        ]),
      },
    });
  });

  // S3 holds a presigned address to the expiry it carries, which the pipeline API chooses. This
  // holds it to five minutes whatever the API signs.
  it("refuses, from anyone, a presigned request signed more than five minutes ago", () => {
    const built = template();
    const [bucketId] = Object.keys(built.findResources("AWS::S3::Bucket"));
    assert(bucketId !== undefined);

    built.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Sid: "DenyStaleSignedAddresses",
            Effect: "Deny",
            Principal: { AWS: "*" },
            Action: "s3:*",
            Resource: [{ "Fn::GetAtt": [bucketId, "Arn"] }, OBJECTS],
            Condition: {
              StringEquals: { "s3:authType": "REST-QUERY-STRING" },
              NumericGreaterThan: { "s3:signatureAge": "300000" },
            },
          },
        ]),
      },
    });
  });

  it("refuses, from anyone, to delete an object or a version of one", () => {
    template().hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Sid: "DenyDeletingABundle",
            Effect: "Deny",
            Principal: { AWS: "*" },
            Action: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
            Resource: OBJECTS,
          },
        ]),
      },
    });
  });

  // A lifecycle rule that expires objects removes them without a delete request, so the
  // refusal above never sees it. The action is the bucket's, so the resource is the bucket.
  it("refuses, from anyone, a change to the bucket's lifecycle rules, and has none", () => {
    const built = template();
    const [bucketId] = Object.keys(built.findResources("AWS::S3::Bucket"));
    assert(bucketId !== undefined);

    built.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Sid: "DenyExpiringBundles",
            Effect: "Deny",
            Principal: { AWS: "*" },
            Action: "s3:PutLifecycleConfiguration",
            Resource: { "Fn::GetAtt": [bucketId, "Arn"] },
          },
        ]),
      },
    });
    built.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: Match.absent(),
    });
  });

  it("grants nothing: every statement of its policy is a refusal", () => {
    const [policy] = Object.values(
      template().findResources("AWS::S3::BucketPolicy"),
    );
    const statements = (
      policy?.Properties as {
        PolicyDocument: { Statement: { Effect: string }[] };
      }
    ).PolicyDocument.Statement;

    expect(statements.length).toBeGreaterThanOrEqual(6);
    expect(statements.map(({ Effect }) => Effect)).not.toContain("Allow");
  });
});
