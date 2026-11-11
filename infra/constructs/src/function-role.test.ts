import { Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { PolicyDocument, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { describe, expect, it } from "vitest";

import { cdkApp } from "./cdk-app.ts";
import {
  functionRoleStatements,
  logGroupWriteStatements,
} from "./function-role.ts";

const ARN = "eu-west-2:123456789012";
const LOG_GROUP = `arn:aws:logs:${ARN}:log-group:/flex/test/function`;

const NETWORK_INTERFACE_ACTIONS = [
  "ec2:AssignPrivateIpAddresses",
  "ec2:CreateNetworkInterface",
  "ec2:DeleteNetworkInterface",
  "ec2:DescribeNetworkInterfaces",
  "ec2:DescribeSubnets",
  "ec2:UnassignPrivateIpAddresses",
];

function build() {
  const stack = new Stack(cdkApp(), "Test", {
    env: { account: "123456789012", region: "eu-west-2" },
  });
  const execution = functionRoleStatements(stack, {
    logGroupName: "/flex/test/function",
    logGroupKey: new Key(stack, "LogGroupKey", { enableKeyRotation: true }),
    functions: "test-sandbox-*",
  });
  new Role(stack, "Role", {
    assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    inlinePolicies: {
      Execution: new PolicyDocument({ statements: execution.statements }),
    },
  });
  return { execution, template: Template.fromStack(stack) };
}

describe("functionRoleStatements", () => {
  it("writes to its own log group, through its key, and lets Lambda alone manage its network interfaces", () => {
    build().template.hasResourceProperties("AWS::IAM::Role", {
      Policies: Match.exact([
        {
          PolicyName: "Execution",
          PolicyDocument: {
            Statement: [
              {
                Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                Effect: "Allow",
                Resource: `${LOG_GROUP}:*`,
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
                    "kms:EncryptionContext:aws:logs:arn": LOG_GROUP,
                  },
                },
              },
              {
                Action: NETWORK_INTERFACE_ACTIONS,
                Effect: "Allow",
                Resource: "*",
              },
              {
                Action: [
                  "ec2:AssignPrivateIpAddresses",
                  "ec2:CreateNetworkInterface",
                  "ec2:DeleteNetworkInterface",
                  "ec2:DescribeNetworkInterfaces",
                  "ec2:DescribeSubnets",
                  "ec2:DetachNetworkInterface",
                  "ec2:UnassignPrivateIpAddresses",
                ],
                Effect: "Deny",
                Resource: "*",
                Condition: {
                  ArnLike: {
                    "lambda:SourceFunctionArn": `arn:aws:lambda:${ARN}:function:test-sandbox-*`,
                  },
                },
              },
            ],
            Version: "2012-10-17",
          },
        },
      ]),
    });
  });

  it("writes only to the log group, with no network grant, when the function isn't in a VPC", () => {
    const stack = new Stack(cdkApp(), "Test", {
      env: { account: "123456789012", region: "eu-west-2" },
    });
    const { statements } = logGroupWriteStatements(stack, {
      logGroupName: "/flex/test/function",
      logGroupKey: new Key(stack, "LogGroupKey", { enableKeyRotation: true }),
    });
    expect(statements.map((statement) => statement.actions)).toEqual([
      ["logs:CreateLogStream", "logs:PutLogEvents"],
      ["kms:Encrypt", "kms:GenerateDataKey*"],
    ]);
  });

  it("acknowledges the log grants' wildcards, and leaves the network's * to its caller", () => {
    expect(build().execution.acknowledgements.map(({ id }) => id)).toEqual([
      `AwsSolutions-IAM5[Resource::${LOG_GROUP}:*]`,
      "AwsSolutions-IAM5[Action::kms:GenerateDataKey*]",
    ]);
  });
});
