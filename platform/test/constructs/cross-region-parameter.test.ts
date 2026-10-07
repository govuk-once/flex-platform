import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { CrossRegionParameter } from "../../src/constructs/cross-region-parameter.ts";

describe("CrossRegionParameter", () => {
  it("reads the one parameter from the other region, on every deploy", () => {
    const stack = new Stack(new App(), "Test", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const parameter = new CrossRegionParameter(stack, "Zone", {
      parameterName: "/infra/dns/hostedzoneid",
      region: "eu-west-2",
    });
    const template = Template.fromStack(stack);

    expect(parameter.stringValue).toBeTruthy();
    template.hasResourceProperties("Custom::AWS", {
      Create: Match.serializedJson(
        Match.objectLike({
          service: "SSM",
          action: "getParameter",
          parameters: { Name: "/infra/dns/hostedzoneid" },
          region: "eu-west-2",
        }),
      ),
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: [
          {
            Action: "ssm:GetParameter",
            Effect: "Allow",
            Resource: {
              "Fn::Join": [
                "",
                [
                  "arn:",
                  { Ref: "AWS::Partition" },
                  ":ssm:eu-west-2:123456789012:parameter/infra/dns/hostedzoneid",
                ],
              ],
            },
          },
        ],
      },
    });
  });
});
