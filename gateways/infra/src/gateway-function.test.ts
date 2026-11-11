import { readdirSync } from "node:fs";
import { join } from "node:path";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { assert, describe, expect, it } from "vitest";

import { ACCOUNT, BUNDLE, stack } from "../test/helpers.ts";
import {
  GatewayFunction,
  type GatewayFunctionProps,
} from "./gateway-function.ts";

const SECRET = `arn:aws:secretsmanager:eu-west-2:${ACCOUNT}:secret:gateway-sandbox-udp-??????`;

const PROPS: GatewayFunctionProps = {
  functionName: "gateway-sandbox-udp",
  roleName: "gateway-sandbox-udp-execution",
  logGroupName: "/flex/gateway/sandbox/udp/function",
  bundle: BUNDLE,
  environment: { FLEX_UPSTREAM_SECRET_ARN: SECRET },
  statements: [
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["secretsmanager:GetSecretValue"],
      resources: [SECRET],
    }),
  ],
  subnetIdsParameterName: "/flex/network/sandbox/private-subnet-ids",
  securityGroupIdParameterName:
    "/flex/network/sandbox/security-group/private-gateway",
  gatewayFunctions: "gateway-sandbox-*",
};

function build(props: GatewayFunctionProps = PROPS, nag = false) {
  const scope = stack(nag);
  const gateway = new GatewayFunction(scope, "Gateway", props);
  return { scope, gateway, template: Template.fromStack(scope) };
}

describe("GatewayFunction", () => {
  it("runs the bundle on Node.js 24, named, with its environment", () => {
    build().template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "gateway-sandbox-udp",
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      Handler: "bundle.handler",
      Timeout: 28,
      Environment: {
        Variables: { FLEX_UPSTREAM_SECRET_ARN: SECRET },
      },
      LoggingConfig: {
        LogGroup: { Ref: Match.stringLikeRegexp("^GatewayLogsLogGroup") },
      },
    });
  });

  it("runs in its placement's subnets and security group, as the network writes them to SSM", () => {
    const { template } = build();
    const parameters = template.toJSON().Parameters as Record<
      string,
      { Type: string; Default: string }
    >;
    const named = (name: string) =>
      Object.entries(parameters).find(
        ([, { Default }]) => Default === name,
      )?.[0];

    const subnets = named("/flex/network/sandbox/private-subnet-ids");
    const group = named("/flex/network/sandbox/security-group/private-gateway");
    expect(subnets).toBeDefined();
    expect(group).toBeDefined();
    template.hasResourceProperties("AWS::Lambda::Function", {
      VpcConfig: {
        SubnetIds: { Ref: subnets },
        SecurityGroupIds: [{ Ref: group }],
      },
    });
  });

  it("is invoked through the live alias, on a version the stack publishes", () => {
    const { template } = build();
    template.resourceCountIs("AWS::Lambda::Version", 1);
    template.hasResourceProperties("AWS::Lambda::Alias", {
      Name: "live",
      FunctionVersion: {
        "Fn::GetAtt": [
          Match.stringLikeRegexp("^GatewayFunctionCurrentVersion"),
          "Version",
        ],
      },
    });
  });

  it("writes to its own log group, kept for a year and encrypted", () => {
    build().template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/flex/gateway/sandbox/udp/function",
      RetentionInDays: 365,
      KmsKeyId: Match.anyValue(),
    });
  });

  it("gives its role its logs, its network interfaces and the grants it is given, and nothing else", () => {
    const { template } = build();
    const logGroup = `arn:aws:logs:eu-west-2:${ACCOUNT}:log-group:/flex/gateway/sandbox/udp/function`;
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "gateway-sandbox-udp-execution",
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      },
      ManagedPolicyArns: Match.absent(),
      Policies: [
        {
          PolicyName: "Execution",
          PolicyDocument: {
            Statement: [
              {
                Effect: "Allow",
                Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                Resource: `${logGroup}:*`,
              },
              {
                Effect: "Allow",
                Action: ["kms:Encrypt", "kms:GenerateDataKey*"],
                Condition: {
                  StringEquals: {
                    "kms:ViaService": "logs.eu-west-2.amazonaws.com",
                  },
                  ArnEquals: { "kms:EncryptionContext:aws:logs:arn": logGroup },
                },
              },
              {
                Effect: "Allow",
                Action: Match.arrayWith(["ec2:CreateNetworkInterface"]),
                Resource: "*",
              },
              {
                Effect: "Deny",
                Action: Match.arrayWith(["ec2:DetachNetworkInterface"]),
                Resource: "*",
                Condition: {
                  ArnLike: {
                    "lambda:SourceFunctionArn": `arn:aws:lambda:eu-west-2:${ACCOUNT}:function:gateway-sandbox-*`,
                  },
                },
              },
              {
                Effect: "Allow",
                Action: "secretsmanager:GetSecretValue",
                Resource: SECRET,
              },
            ],
          },
        },
      ],
    });
    template.resourceCountIs("AWS::IAM::Policy", 0);
  });

  it("deploys the bundle alone, not what codegen built it from", () => {
    const { scope } = build();
    const [asset] = scope.node
      .findAll()
      .filter((construct) => construct instanceof Asset);
    const app = scope.node.root;
    assert.instanceOf(app, App);
    assert.instanceOf(asset, Asset);

    expect(readdirSync(join(app.outdir, asset.assetPath))).toEqual([
      "bundle.mjs",
    ]);
  });

  it("refuses a bundle that codegen hasn't written", () => {
    expect(() => build({ ...PROPS, bundle: "/nowhere/bundle.mjs" })).toThrow(
      /gateway-sandbox-udp has no bundle at \/nowhere\/bundle.mjs. Run pnpm codegen first./,
    );
  });

  it("has no unacknowledged cdk-nag finding", () => {
    expect(() => build(PROPS, true).scope.node.root).not.toThrow();
  });
});
