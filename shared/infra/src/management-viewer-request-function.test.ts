import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { stackIn, ZONE } from "../test/helpers.ts";
import { ManagementViewerRequestFunction } from "./management-viewer-request-function.ts";

function build(region = "us-east-1") {
  const stack = stackIn(region);
  new ManagementViewerRequestFunction(stack, "ViewerRequest", {
    zoneName: ZONE.zoneName,
  });
  return Template.fromStack(stack);
}

describe("ManagementViewerRequestFunction", () => {
  it("refuses any region but us-east-1", () => {
    expect(() => build("eu-west-2")).toThrow("us-east-1");
  });

  it("is built for the cloudfront-js-2.0 runtime, for GitHub's tokens asked for this stage's pipeline API", () => {
    build().hasResourceProperties("AWS::CloudFront::Function", {
      Name: "shared-management-viewer-request",
      AutoPublish: true,
      FunctionConfig: { Runtime: "cloudfront-js-2.0" },
      FunctionCode: Match.stringLikeRegexp(
        String.raw`https://token\.actions\.githubusercontent\.com.*https://sandbox\.flex-shared\.example/ci`,
      ),
    });
  });

  // CloudFront would create the group itself, with no retention, if the function ran first.
  it("creates the log group CloudFront writes it to", () => {
    build().hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/aws/cloudfront/function/shared-management-viewer-request",
      RetentionInDays: 365,
    });
  });
});
