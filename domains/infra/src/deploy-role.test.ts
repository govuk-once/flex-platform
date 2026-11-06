import type { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ACCOUNT, stackIn } from "../test/helpers.ts";
import { DeployRole } from "./deploy-role.ts";

const SUBNETS_PARAMETER = "/flex/network/sandbox/isolated-subnet-ids";
const SECURITY_GROUP_PARAMETER = "/flex/network/sandbox/security-group/domain";

function build(nag = false) {
  const stack = stackIn("eu-west-2", nag);
  new DeployRole(stack, "Deploy", {
    environment: "sandbox",
    domain: "domain-a",
    gatewayFunctions: "gateway-sandbox-*",
    subnetIdsParameterName: SUBNETS_PARAMETER,
    securityGroupIdParameterName: SECURITY_GROUP_PARAMETER,
  });
  return { app: stack.node.root as App, template: Template.fromStack(stack) };
}

// The template parameter CDK adds to read an SSM parameter at deploy.
function parameterReading(template: Template, name: string): { Ref: string } {
  const parameters = template.toJSON().Parameters as Record<
    string,
    { Type: string; Default: string }
  >;
  const id = Object.keys(parameters).find(
    (key) => parameters[key]?.Default === name,
  );
  if (id === undefined) {
    throw new Error(`nothing reads ${name}`);
  }
  return { Ref: id };
}

const DOMAIN_FUNCTION = `arn:aws:lambda:eu-west-2:${ACCOUNT}:function:domain-sandbox-domain-a`;

const DOMAIN_FUNCTIONS = [DOMAIN_FUNCTION, `${DOMAIN_FUNCTION}:*`];

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
      RoleName: "domain-sandbox-domain-a-deploy",
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

  it("reads its placement from SSM at deploy, as the parameters' types", () => {
    const parameters = build().template.toJSON().Parameters as Record<
      string,
      { Type: string; Default: string }
    >;
    const reads = Object.fromEntries(
      Object.values(parameters)
        .filter(({ Default }) => Default.startsWith("/flex/"))
        .map(({ Type, Default }) => [Default, Type]),
    );

    expect(reads).toEqual({
      [SUBNETS_PARAMETER]: "AWS::SSM::Parameter::Value<List<String>>",
      [SECURITY_GROUP_PARAMETER]: "AWS::SSM::Parameter::Value<String>",
    });
  });

  it("may release its domain's function, read its placement, pass that domain's execution role to Lambda, never touch a gateway, and place every function as the parameters it reads say", () => {
    const { template } = build();
    const subnets = parameterReading(template, SUBNETS_PARAMETER);
    const securityGroup = parameterReading(template, SECURITY_GROUP_PARAMETER);

    template.hasResourceProperties("AWS::IAM::Role", {
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
                Action: ["ssm:GetParameter", "ssm:GetParameters"],
                Effect: "Allow",
                Resource: [
                  `arn:aws:ssm:eu-west-2:${ACCOUNT}:parameter${SUBNETS_PARAMETER}`,
                  `arn:aws:ssm:eu-west-2:${ACCOUNT}:parameter${SECURITY_GROUP_PARAMETER}`,
                ],
              },
              {
                Action: "iam:PassRole",
                Condition: {
                  StringEquals: {
                    "iam:PassedToService": "lambda.amazonaws.com",
                  },
                },
                Effect: "Allow",
                Resource: `arn:aws:iam::${ACCOUNT}:role/domain-sandbox-domain-a-execution`,
              },
              {
                Action: "lambda:*",
                Effect: "Deny",
                Resource: `arn:aws:lambda:eu-west-2:${ACCOUNT}:function:gateway-sandbox-*`,
              },
              placement({ Null: { "lambda:VpcIds": "true" } }),
              placement({
                "ForAnyValue:StringNotEquals": { "lambda:SubnetIds": subnets },
              }),
              placement({
                "ForAnyValue:StringNotEquals": {
                  "lambda:SecurityGroupIds": [securityGroup],
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
