import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { stackIn } from "../test/helpers.ts";
import { CallerTokenKeysBucket } from "./caller-token-keys-bucket.ts";

const READERS = [
  "arn:aws:iam::100000000004:role/gateway-sandbox-udp-execution",
  "arn:aws:iam::100000000003:role/gateway-sandbox-udp-execution",
  "arn:aws:iam::100000000003:role/gateway-sandbox-udp-execution",
];

function build(readerRoles: readonly string[] = READERS, nag = false) {
  const stack = stackIn("eu-west-2", nag);
  new CallerTokenKeysBucket(stack, "Keys", {
    environment: "sandbox",
    readerRoles,
  });
  return Template.fromStack(stack);
}

describe("CallerTokenKeysBucket", () => {
  it("is named for the environment and its account", () => {
    build().hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "frontdoor-sandbox-keys-123456789012",
    });
  });

  it("lets each gateway's role, and no other, read the public keys' object, and nothing else", () => {
    const statements = build().findResources("AWS::S3::BucketPolicy");
    const [policy] = Object.values(statements) as {
      Properties: { PolicyDocument: { Statement: unknown[] } };
    }[];
    expect(policy?.Properties.PolicyDocument.Statement).toContainEqual({
      Effect: "Allow",
      Principal: {
        AWS: [
          "arn:aws:iam::100000000003:root",
          "arn:aws:iam::100000000004:root",
        ],
      },
      Action: "s3:GetObject",
      Resource: {
        "Fn::Join": [
          "",
          [
            { "Fn::GetAtt": [expect.stringMatching(/^KeysStore/), "Arn"] },
            "/caller-token-keys.json",
          ],
        ],
      },
      Condition: {
        ArnEquals: {
          "aws:PrincipalArn": [
            "arn:aws:iam::100000000003:role/gateway-sandbox-udp-execution",
            "arn:aws:iam::100000000004:role/gateway-sandbox-udp-execution",
          ],
        },
      },
    });
  });

  it("lets nothing read it while no gateway is deployed", () => {
    const statements = Object.values(
      build([]).findResources("AWS::S3::BucketPolicy"),
    ).flatMap(
      (policy) =>
        (policy as { Properties: { PolicyDocument: { Statement: unknown[] } } })
          .Properties.PolicyDocument.Statement,
    );
    expect(statements).not.toContainEqual(
      expect.objectContaining({ Effect: "Allow" }),
    );
  });

  it("has no unacknowledged cdk-nag finding", () => {
    expect(() => build(READERS, true)).not.toThrow();
  });
});
