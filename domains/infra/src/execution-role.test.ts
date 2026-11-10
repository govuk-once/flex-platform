import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Key } from "aws-cdk-lib/aws-kms";
import { assert, describe, expect, it } from "vitest";

import { ACCOUNT, stackIn } from "../test/helpers.ts";
import { ExecutionRole } from "./execution-role.ts";

function build(nag = false) {
  const stack = stackIn("eu-west-2", nag);
  new ExecutionRole(stack, "Execution", {
    environment: "sandbox",
    domain: "domain-a",
    gatewayFunctions: "gateway-sandbox-*",
    lambdaEndpointId: "vpce-0lambda",
    logGroupKey: new Key(stack, "LogGroupKey", { enableKeyRotation: true }),
  });
  const app = stack.node.root;
  assert.instanceOf(app, App);
  return { app, template: Template.fromStack(stack) };
}

const ARN = `eu-west-2:${ACCOUNT}`;

const FUNCTION_LOG_GROUP = `arn:aws:logs:${ARN}:log-group:/flex/domain/sandbox/domain-a/function`;

const STATEMENTS = [
  {
    Action: "lambda:InvokeFunction",
    Effect: "Allow",
    Resource: `arn:aws:lambda:${ARN}:function:gateway-sandbox-*`,
  },
  {
    Action: "lambda:InvokeFunction",
    Effect: "Deny",
    Resource: "*",
    Condition: { StringNotEquals: { "aws:SourceVpce": "vpce-0lambda" } },
  },
  {
    Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
    Effect: "Allow",
    Resource: `${FUNCTION_LOG_GROUP}:*`,
  },
  {
    Action: ["kms:Encrypt", "kms:GenerateDataKey*"],
    Effect: "Allow",
    Resource: {
      "Fn::GetAtt": [Match.stringLikeRegexp("^LogGroupKey"), "Arn"],
    },
    Condition: {
      StringEquals: { "kms:ViaService": "logs.eu-west-2.amazonaws.com" },
      ArnEquals: { "kms:EncryptionContext:aws:logs:arn": FUNCTION_LOG_GROUP },
    },
  },
  {
    Action: [
      "ec2:AssignPrivateIpAddresses",
      "ec2:CreateNetworkInterface",
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribeSubnets",
      "ec2:UnassignPrivateIpAddresses",
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments",
    ],
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
        "lambda:SourceFunctionArn": `arn:aws:lambda:${ARN}:function:domain-sandbox-*`,
      },
    },
  },
];

describe("ExecutionRole", () => {
  it("has no unacknowledged cdk-nag finding", () => {
    expect(() => build(true).app.synth()).not.toThrow();
  });

  it("is assumed by Lambda alone, with a fixed name", () => {
    build().template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "domain-sandbox-domain-a-execution",
      AssumeRolePolicyDocument: Match.exact({
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
          },
        ],
        Version: "2012-10-17",
      }),
    });
  });

  it("may invoke the gateways named through the endpoint alone, write its own domain's logs and its traces and run in a VPC, and denies the network to its code", () => {
    build().template.hasResourceProperties("AWS::IAM::Role", {
      Policies: Match.exact([
        {
          PolicyName: "Execution",
          PolicyDocument: { Statement: STATEMENTS, Version: "2012-10-17" },
        },
      ]),
    });
  });

  it("is bounded by the same limits", () => {
    const { template } = build();

    const boundaries = template.findResources("AWS::IAM::ManagedPolicy");
    const [boundary] = Object.keys(boundaries);

    expect(Object.keys(boundaries)).toHaveLength(1);
    template.hasResourceProperties("AWS::IAM::Role", {
      PermissionsBoundary: { Ref: boundary },
    });
    template.hasResourceProperties("AWS::IAM::ManagedPolicy", {
      PolicyDocument: Match.exact({
        Statement: STATEMENTS,
        Version: "2012-10-17",
      }),
    });
  });
});
