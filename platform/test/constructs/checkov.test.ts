import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { describe, expect, it } from "vitest";

import { applyCheckovSkips } from "../../src/constructs/checkov.ts";

describe("applyCheckovSkips", () => {
  it("records the skips and their reasons on the resource", () => {
    const stack = new Stack(new App(), "Test");
    const bucket = new Bucket(stack, "Bucket");

    applyCheckovSkips(bucket, [{ id: "CKV_AWS_18", comment: "a reason" }]);

    Template.fromStack(stack).hasResource("AWS::S3::Bucket", {
      Metadata: {
        checkov: { skip: [{ id: "CKV_AWS_18", comment: "a reason" }] },
      },
    });
  });

  it("refuses a construct with no resource behind it", () => {
    const stack = new Stack(new App(), "Test");
    const empty = new Construct(stack, "Empty");

    expect(() =>
      applyCheckovSkips(empty, [{ id: "CKV_AWS_18", comment: "" }]),
    ).toThrow("no CloudFormation resource");
  });
});
