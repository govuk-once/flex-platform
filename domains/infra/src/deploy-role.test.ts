import type { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ACCOUNT, stackIn } from "../test/helpers.ts";
import { DeployRole } from "./deploy-role.ts";

const SUBNETS = ["subnet-0a1b2c3d", "subnet-4e5f6a7b"];
const SECURITY_GROUP = "sg-0a1b2c3d";

function build(nag = false) {
  const stack = stackIn("eu-west-2", nag);
  new DeployRole(stack, "Deploy", {
    environment: "sandbox",
    gatewayFunctions: "gateway-sandbox-*",
    subnetIds: SUBNETS,
    securityGroupId: SECURITY_GROUP,
  });
  return { app: stack.node.root as App, template: Template.fromStack(stack) };
}

const DOMAIN_FUNCTIONS = `arn:aws:lambda:eu-west-2:${ACCOUNT}:function:domain-sandbox-*`;

const PLACED = ["lambda:CreateFunction", "lambda:UpdateFunctionConfiguration"];

function placement(Condition: unknown) {
  return {
    Action: PLACED,
    Condition,
    Effect: "Deny",
    Resource: DOMAIN_FUNCTIONS,
  };
}

describe("DeployRole", () => {
  it("has no unacknowledged cdk-nag finding", () => {
    expect(() => build(true).app.synth()).not.toThrow();
  });

  it("is assumed only by principals in its own account, with a fixed name", () => {
    build().template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "domain-sandbox-deploy",
      AssumeRolePolicyDocument: Match.exact({
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` },
          },
        ],
        Version: "2012-10-17",
      }),
    });
  });

  it("may release domain functions, pass the execution role to Lambda, never touch a gateway, and place every function in the network named", () => {
    build().template.hasResourceProperties("AWS::IAM::Role", {
      Policies: Match.exact([
        {
          PolicyName: "Deploy",
          PolicyDocument: {
            Statement: [
              {
                Action: [
                  "lambda:CreateAlias",
                  "lambda:CreateFunction",
                  "lambda:GetAlias",
                  "lambda:GetFunction",
                  "lambda:GetFunctionConfiguration",
                  "lambda:PublishVersion",
                  "lambda:UpdateAlias",
                  "lambda:UpdateFunctionCode",
                  "lambda:UpdateFunctionConfiguration",
                ],
                Effect: "Allow",
                Resource: DOMAIN_FUNCTIONS,
              },
              {
                Action: [
                  "ec2:DescribeSecurityGroups",
                  "ec2:DescribeSubnets",
                  "ec2:DescribeVpcs",
                  "ec2:GetSecurityGroupsForVpc",
                ],
                Effect: "Allow",
                Resource: "*",
              },
              {
                Action: "iam:PassRole",
                Condition: {
                  StringEquals: {
                    "iam:PassedToService": "lambda.amazonaws.com",
                  },
                },
                Effect: "Allow",
                Resource: `arn:aws:iam::${ACCOUNT}:role/domain-sandbox-execution`,
              },
              {
                Action: "lambda:*",
                Effect: "Deny",
                Resource: `arn:aws:lambda:eu-west-2:${ACCOUNT}:function:gateway-sandbox-*`,
              },
              placement({ Null: { "lambda:VpcIds": "true" } }),
              placement({
                "ForAnyValue:StringNotEquals": { "lambda:SubnetIds": SUBNETS },
              }),
              placement({
                "ForAnyValue:StringNotEquals": {
                  "lambda:SecurityGroupIds": [SECURITY_GROUP],
                },
              }),
            ],
            Version: "2012-10-17",
          },
        },
      ]),
    });
  });
});
