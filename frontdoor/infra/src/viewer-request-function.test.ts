import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";

import { ISSUERS, stackIn } from "../test/helpers.ts";
import { ViewerRequestFunction } from "./viewer-request-function.ts";

describe("ViewerRequestFunction", () => {
  it("is built for the cloudfront-js-2.0 runtime with the environment's issuers baked in", () => {
    const stack = stackIn("us-east-1");
    new ViewerRequestFunction(stack, "ViewerRequest", { issuers: ISSUERS });

    Template.fromStack(stack).hasResourceProperties(
      "AWS::CloudFront::Function",
      {
        AutoPublish: true,
        FunctionConfig: { Runtime: "cloudfront-js-2.0" },
        FunctionCode: Match.stringLikeRegexp("eu-west-2_example"),
      },
    );
  });
});
