import { cdkApp } from "@repo/infra-constructs";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../../test/helpers.ts";
import { frontdoorStackName } from "./frontdoor.ts";
import {
  FrontdoorEdgeLogsStack,
  frontdoorEdgeLogsStackName,
} from "./frontdoor-edge-logs.ts";

const PROD = FIXTURE_STAGES[2];
const [DEV] = PROD.environments;

describe("FrontdoorEdgeLogsStack", () => {
  it("is one per environment, in its frontdoor account, in eu-west-2, deployed before the edge", () => {
    const assembly = synthesizedStage(PROD);

    for (const environment of PROD.environments) {
      const stack = assembly.getStackByName(
        frontdoorEdgeLogsStackName(environment, "eu-west-2"),
      );
      expect(stack.environment).toMatchObject({
        account: environment.frontdoor.account,
        region: "eu-west-2",
      });
      expect(stack.terminationProtection).toBe(true);
      expect(
        assembly
          .getStackByName(frontdoorStackName(environment))
          .dependencies.map((dependency) => dependency.id),
      ).toContain(frontdoorEdgeLogsStackName(environment, "eu-west-2"));
    }
  });

  it("holds the origin request function's log group, its key and the policy to write to it", () => {
    const template = Template.fromStack(
      new FrontdoorEdgeLogsStack(cdkApp(), DEV, "eu-west-2"),
    );

    template.resourceCountIs("AWS::Logs::LogGroup", 1);
    template.resourceCountIs("AWS::KMS::Key", 1);
    template.resourceCountIs("AWS::IAM::ManagedPolicy", 1);
    expect(Object.keys(template.toJSON().Resources as object)).toHaveLength(3);
    template.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
      Properties: {
        LogGroupName: `/flex/frontdoor/${DEV.name}/origin-request`,
        RetentionInDays: 365,
      },
    });
  });

  it("names its stack from the region and the environment", () => {
    expect(frontdoorEdgeLogsStackName(DEV, "eu-west-2")).toBe(
      "frontdoor-dev-edge-logs-eu-west-2",
    );
  });
});
