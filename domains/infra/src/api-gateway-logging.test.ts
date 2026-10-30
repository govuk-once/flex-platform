import type { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ACCOUNT, stackIn } from "../test/helpers.ts";
import { ApiGatewayLogging } from "./api-gateway-logging.ts";

function build(nag = false) {
  const stack = stackIn("eu-west-2", nag);
  new ApiGatewayLogging(stack, "ApiGatewayLogging", {
    environment: "sandbox",
  });
  return { app: stack.node.root as App, template: Template.fromStack(stack) };
}

const ARN = `eu-west-2:${ACCOUNT}`;
const ACCESS_LOGS = `arn:aws:logs:${ARN}:log-group:/flex/domain/sandbox/*/api-access`;
const EXECUTION_LOGS = `arn:aws:logs:${ARN}:log-group:API-Gateway-Execution-Logs_*/*`;

describe("ApiGatewayLogging", () => {
  it("has no unacknowledged cdk-nag finding", () => {
    expect(() => build(true).app.synth()).not.toThrow();
  });

  it("is set on the account, through a role API Gateway assumes", () => {
    const { template } = build();

    template.resourceCountIs("AWS::ApiGateway::Account", 1);
    template.hasResourceProperties("AWS::ApiGateway::Account", {
      CloudWatchRoleArn: {
        "Fn::GetAtt": [Match.stringLikeRegexp("Role"), "Arn"],
      },
    });
  });

  it("is assumed by API Gateway alone", () => {
    build().template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.exact({
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: { Service: "apigateway.amazonaws.com" },
          },
        ],
        Version: "2012-10-17",
      }),
    });
  });

  it("may write only to the domains' API log groups, and creates none", () => {
    const { template } = build();

    template.resourceCountIs("AWS::Logs::LogGroup", 0);
    template.hasResourceProperties("AWS::IAM::Role", {
      Policies: Match.exact([
        {
          PolicyName: "WriteLogs",
          PolicyDocument: {
            Statement: [
              {
                Action: [
                  "logs:CreateLogStream",
                  "logs:DescribeLogStreams",
                  "logs:PutLogEvents",
                ],
                Effect: "Allow",
                Resource: [`${ACCESS_LOGS}:*`, `${EXECUTION_LOGS}:*`],
              },
              {
                Action: "logs:DescribeLogGroups",
                Effect: "Allow",
                Resource: "*",
              },
              {
                Action: ["kms:Encrypt", "kms:GenerateDataKey*"],
                Effect: "Allow",
                Resource: `arn:aws:kms:${ARN}:key/*`,
                Condition: {
                  StringEquals: {
                    "kms:ViaService": "logs.eu-west-2.amazonaws.com",
                  },
                  ArnLike: {
                    "kms:EncryptionContext:aws:logs:arn": [
                      ACCESS_LOGS,
                      EXECUTION_LOGS,
                    ],
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
});
