import { Duration, Stack, Stage, Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { AwsSolutionsChecks } from "cdk-nag";
import { assert, describe, expect, it } from "vitest";

import { cdkApp } from "./cdk-app.ts";
import { platformFunction } from "./platform-function.ts";

function build(nag = false): Stack {
  const app = cdkApp();
  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const stack = new Stack(app, "Test", {
    env: { account: "123456789012", region: "eu-west-2" },
  });
  platformFunction(stack, {
    functionName: "example-function",
    roleName: "example-role",
    logGroupName: "/example/function",
    policyName: "Example",
    statements: [
      new PolicyStatement({ actions: ["sqs:SendMessage"], resources: ["*"] }),
    ],
    acknowledgements: [
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason: "The test's statement takes every queue.",
      },
    ],
    code: "exports.handler = async () => undefined;",
    timeout: Duration.seconds(10),
    memorySize: 256,
    reservedConcurrentExecutions: 1,
  });
  return stack;
}

describe("platformFunction", () => {
  it("builds its parts under the IDs a construct that built them itself gave them", () => {
    const template = Template.fromStack(build());

    expect(
      Object.keys(template.findResources("AWS::Lambda::Function")),
    ).toEqual([expect.stringMatching(/^Function[0-9A-F]{8}$/)]);
    expect(Object.keys(template.findResources("AWS::IAM::Role"))).toEqual([
      expect.stringMatching(/^Role[0-9A-F]{8}$/),
    ]);
    expect(Object.keys(template.findResources("AWS::Logs::LogGroup"))).toEqual([
      expect.stringMatching(/^LogsLogGroup[0-9A-F]{8}$/),
    ]);
  });

  it("runs the bundle's handler on ARM, as its own role, logging to its own group", () => {
    const template = Template.fromStack(build());

    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "example-function",
      Handler: "index.handler",
      Runtime: "nodejs26.x",
      Architectures: ["arm64"],
      Timeout: 10,
      MemorySize: 256,
      ReservedConcurrentExecutions: 1,
      LoggingConfig: { LogGroup: { Ref: Match.anyValue() } },
    });
  });

  it("lets the role write to its log group, and do what the statements say", () => {
    const template = Template.fromStack(build());

    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "example-role",
      Policies: [
        {
          PolicyName: "Example",
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
              }),
              Match.objectLike({ Action: "sqs:SendMessage", Resource: "*" }),
            ]),
          },
        },
      ],
    });
  });

  it("has no unacknowledged cdk-nag finding", () => {
    const app = Stage.of(build(true));
    assert.isDefined(app);

    expect(() => app.synth()).not.toThrow();
  });
});
