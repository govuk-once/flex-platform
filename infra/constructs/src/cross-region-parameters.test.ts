import { type App, Stack, Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { assert, describe, expect, it } from "vitest";

import { cdkApp } from "./cdk-app.ts";
import {
  CROSS_REGION_PARAMETER_PATH,
  crossRegionParameterName,
  CrossRegionParameters,
} from "./cross-region-parameters.ts";
import { LogGroupCheck } from "./validation/log-group-check.ts";

const HOST = crossRegionParameterName("shared", "ci-origin-host");
const OTHER = crossRegionParameterName("shared", "api-origin-host");
const LOG_GROUP = "/flex/shared/cross-region-writer";

type Parameters = Readonly<Record<string, Readonly<Record<string, string>>>>;

const ONE = { "us-east-1": { [HOST]: "abc.example" } };
const TWO = {
  "us-east-1": { [HOST]: "abc.example", [OTHER]: "def.example" },
};

function testStack(checks = false): { app: App; stack: Stack } {
  const app = cdkApp();
  if (checks) {
    Validations.of(app).addPlugins(
      new AwsSolutionsChecks(app),
      new LogGroupCheck(),
    );
  }
  const stack = new Stack(app, "Test", {
    env: { account: "123456789012", region: "eu-west-2" },
  });
  return { app, stack };
}

function write(stack: Stack, parameters: Parameters): void {
  new CrossRegionParameters(stack, "CrossRegion", {
    logGroupName: LOG_GROUP,
    parameters,
  });
}

function build(parameters: Parameters = ONE): Template {
  const { stack } = testStack();
  write(stack, parameters);
  return Template.fromStack(stack);
}

// A custom resource's calls are JSON in its properties.
function call(
  template: Template,
  property: "Create" | "Update" | "Delete",
): unknown {
  const [resource] = Object.values(
    template.findResources("Custom::CrossRegionParameter"),
  );
  assert(resource !== undefined);
  const value = (resource.Properties as Record<string, unknown>)[property];
  assert(typeof value === "string");
  return JSON.parse(value);
}

function policyStatements(template: Template): Record<string, unknown>[] {
  return Object.values(template.findResources("AWS::IAM::Role")).flatMap(
    (role) =>
      (
        role.Properties as {
          Policies: {
            PolicyDocument: { Statement: Record<string, unknown>[] };
          }[];
        }
      ).Policies.flatMap(({ PolicyDocument }) => PolicyDocument.Statement),
  );
}

describe("crossRegionParameterName", () => {
  it("puts every parameter under one path", () => {
    expect(HOST).toBe("/flex/cross-region/shared/ci-origin-host");
    expect(HOST.startsWith(CROSS_REGION_PARAMETER_PATH)).toBe(true);
  });
});

describe("CrossRegionParameters", () => {
  it("passes cdk-nag and the platform's log group check", () => {
    const { app, stack } = testStack(true);
    write(stack, TWO);

    expect(() => app.synth()).not.toThrow();
  });

  it("writes a value to its parameter in the other region, on create and on update", () => {
    const template = build();

    const expected = {
      service: "SSM",
      action: "putParameter",
      parameters: {
        Name: HOST,
        Value: "abc.example",
        Type: "String",
        Overwrite: true,
      },
      region: "us-east-1",
      physicalResourceId: { id: `us-east-1:${HOST}` },
    };
    expect(call(template, "Create")).toEqual(expected);
    expect(call(template, "Update")).toEqual(expected);
  });

  it("deletes the parameter with its stack, and accepts one already gone", () => {
    expect(call(build(), "Delete")).toEqual({
      service: "SSM",
      action: "deleteParameter",
      parameters: { Name: HOST },
      region: "us-east-1",
      ignoreErrorCodesMatching: "ParameterNotFound",
    });
  });

  // A timestamp, or anything else that differs between synths, would write on every deploy and
  // make every template differ from the last.
  it("synthesizes the same template every time", () => {
    expect(build(TWO).toJSON()).toEqual(build(TWO).toJSON());
  });

  it("keeps a writer's logical ID whatever else is written, in any order", () => {
    const ids = (parameters: Parameters) =>
      Object.entries(
        build(parameters).findResources("Custom::CrossRegionParameter"),
      )
        .filter(([, resource]) =>
          JSON.stringify(resource.Properties).includes(HOST),
        )
        .map(([id]) => id);

    const alone = ids(ONE);
    expect(alone).toHaveLength(1);
    expect(ids(TWO)).toEqual(alone);
    expect(
      ids({ "us-east-1": { [OTHER]: "def.example", [HOST]: "abc.example" } }),
    ).toEqual(alone);
    expect(ids({ "eu-west-1": { [OTHER]: "def.example" }, ...ONE })).toEqual(
      alone,
    );
  });

  it("may write and delete only its own parameters, in the other region", () => {
    const ssm = policyStatements(build(TWO)).filter(({ Action }) =>
      JSON.stringify(Action).includes("ssm:"),
    );

    expect(ssm).toEqual([
      {
        Effect: "Allow",
        Action: ["ssm:DeleteParameter", "ssm:PutParameter"],
        // In the order the names sort, whatever order they were given in.
        Resource: [OTHER, HOST].map(
          (name) => `arn:aws:ssm:us-east-1:123456789012:parameter${name}`,
        ),
      },
    ]);
  });

  it("writes a name in each region it is given for, as its own resource", () => {
    const template = build({
      "us-east-1": { [HOST]: "abc.example" },
      "eu-west-1": { [HOST]: "abc.example" },
    });

    const regions = Object.values(
      template.findResources("Custom::CrossRegionParameter"),
    ).map(
      (resource) =>
        (
          JSON.parse(
            String((resource.Properties as Record<string, unknown>)["Create"]),
          ) as { region: string }
        ).region,
    );
    expect(regions.toSorted()).toEqual(["eu-west-1", "us-east-1"]);

    const ssm = policyStatements(template).filter(({ Action }) =>
      JSON.stringify(Action).includes("ssm:"),
    );
    expect(ssm).toEqual([
      {
        Effect: "Allow",
        Action: ["ssm:DeleteParameter", "ssm:PutParameter"],
        Resource: ["eu-west-1", "us-east-1"].map(
          (region) => `arn:aws:ssm:${region}:123456789012:parameter${HOST}`,
        ),
      },
    ]);
  });

  it("runs every writer in one function, with one role and one log group", () => {
    const template = build(TWO);

    template.resourceCountIs("Custom::CrossRegionParameter", 2);
    template.resourceCountIs("AWS::Lambda::Function", 1);
    template.resourceCountIs("AWS::IAM::Role", 1);
    template.resourceCountIs("AWS::IAM::Policy", 0);
    template.resourceCountIs("AWS::Logs::LogGroup", 1);
  });

  it("logs to the platform's log group by its name, and can create no other", () => {
    const template = build();

    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: LOG_GROUP,
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      LoggingConfig: {
        LogGroup: { Ref: Match.stringLikeRegexp("^CrossRegionLogs") },
      },
    });
    // AWS's managed policy would let the function create a log group.
    template.hasResourceProperties("AWS::IAM::Role", {
      ManagedPolicyArns: Match.absent(),
    });

    const logs = policyStatements(template).filter(({ Action }) =>
      JSON.stringify(Action).includes("logs:"),
    );
    expect(logs).toEqual([
      {
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: `arn:aws:logs:eu-west-2:123456789012:log-group:${LOG_GROUP}:*`,
      },
    ]);
  });

  it("refuses a parameter outside the cross-region path", () => {
    const { stack } = testStack();

    expect(() => {
      write(stack, {
        "us-east-1": { "/flex/shared/ci-origin-host": "abc.example" },
      });
    }).toThrow(
      "the parameter /flex/shared/ci-origin-host must be under /flex/cross-region/",
    );
  });

  it("refuses the stack's own region, where CloudFormation writes a parameter itself", () => {
    const { stack } = testStack();

    expect(() => {
      write(stack, { ...ONE, "eu-west-2": { [OTHER]: "def.example" } });
    }).toThrow("eu-west-2 is the stack's own region");
  });

  // CDK's one function would keep the first set's role, so the second's writes would be refused
  // at deploy.
  it("refuses a second set in a stack", () => {
    const { stack } = testStack();
    write(stack, ONE);

    expect(
      () =>
        new CrossRegionParameters(stack, "Second", {
          logGroupName: "/flex/shared/second",
          parameters: { "us-east-1": { [OTHER]: "def.example" } },
        }),
    ).toThrow("Test already has an AWS custom resource");
  });
});
