import { cdkApp } from "@repo/infra-constructs";
import { Stack, Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";

import { OriginRequestLogs } from "./origin-request-logs.ts";

function build(nag = false) {
  const app = cdkApp();
  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const stack = new Stack(app, "Test", {
    env: { account: "123456789012", region: "eu-west-2" },
  });
  new OriginRequestLogs(stack, "Logs", { environment: "sandbox" });
  return { app, template: Template.fromStack(stack) };
}

const LOG_GROUP_ARN =
  "arn:aws:logs:eu-west-2:123456789012:log-group:/flex/frontdoor/sandbox/origin-request";

describe("OriginRequestLogs", () => {
  it("has no unacknowledged cdk-nag finding", () => {
    expect(() => build(true).app.synth()).not.toThrow();
  });

  it("creates the function's log group, named from config", () => {
    build().template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/flex/frontdoor/sandbox/origin-request",
    });
  });

  it("provides a policy, named from config, to write to that group with its own key alone", () => {
    build().template.hasResourceProperties("AWS::IAM::ManagedPolicy", {
      ManagedPolicyName: "frontdoor-sandbox-origin-request-logs-eu-west-2",
      PolicyDocument: {
        Statement: [
          {
            Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Effect: "Allow",
            Resource: `${LOG_GROUP_ARN}:*`,
          },
          {
            Action: ["kms:Encrypt", "kms:GenerateDataKey*"],
            Effect: "Allow",
            Resource: {
              "Fn::GetAtt": [Match.stringLikeRegexp("^LogGroupKey"), "Arn"],
            },
            Condition: {
              StringEquals: {
                "kms:ViaService": "logs.eu-west-2.amazonaws.com",
              },
              ArnEquals: {
                "kms:EncryptionContext:aws:logs:arn": LOG_GROUP_ARN,
              },
            },
          },
        ],
      },
    });
  });

  it("attaches the policy to nothing: the role attaches it by name", () => {
    const [policy] = Object.values(
      build().template.findResources("AWS::IAM::ManagedPolicy"),
    );
    expect(policy?.Properties).not.toHaveProperty("Roles");
  });
});
