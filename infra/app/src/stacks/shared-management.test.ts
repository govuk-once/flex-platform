import { cdkApp } from "@repo/infra-constructs";
import { MANAGEMENT_REGION } from "@repo/shared-infra";
import { Match, Template } from "aws-cdk-lib/assertions";
import { assert, describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../../test/helpers.ts";
import { inventory } from "../inventory.ts";
import {
  SHARED_MANAGEMENT_STACK_NAME,
  SharedManagementStack,
} from "./shared-management.ts";
import { SHARED_RELEASE_STACK_NAME } from "./shared-release.ts";

const [, , PROD] = FIXTURE_STAGES;

function template(): Template {
  return Template.fromStack(new SharedManagementStack(cdkApp(), PROD.shared));
}

describe("SharedManagementStack", () => {
  // Every stage has the distribution, so the stacks are the same in each. Only the zone differs.
  it.each(FIXTURE_STAGES)("is built in $name", (stage) => {
    expect(
      synthesizedStage(stage).stacks.map((stack) => stack.stackName),
    ).toContain(SHARED_MANAGEMENT_STACK_NAME);
  });

  it("is in the stage's shared account, where CloudFront takes its web ACL from, protected from deletion", () => {
    const stack = new SharedManagementStack(cdkApp(), PROD.shared);

    expect(stack.stackName).toBe("shared-management");
    expect(stack.account).toBe(PROD.shared.account);
    expect(stack.region).toBe("us-east-1");
    expect(stack.region).toBe(MANAGEMENT_REGION);
    expect(stack.terminationProtection).toBe(true);
  });

  // The parameter it reads must be written first, and nothing waits on the distribution.
  it("deploys after the release stack, and no stack depends on it", () => {
    const stacks = inventory(synthesizedStage(PROD));

    for (const stack of stacks) {
      if (stack.name === SHARED_MANAGEMENT_STACK_NAME) {
        expect(stack.dependencies).toEqual([SHARED_RELEASE_STACK_NAME]);
      } else {
        expect(stack.dependencies).not.toContain(SHARED_MANAGEMENT_STACK_NAME);
      }
    }
  });

  it("answers at the apex of the shared account's zone", () => {
    template().hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: [PROD.shared.zone.name],
      }),
    });
  });

  // No cross-stack reference: the release stack is in another region, and an export would tie
  // the two together.
  it("reads the pipeline API's host from SSM in its own region, as its one origin", () => {
    const built = template();
    const { Parameters } = built.toJSON() as {
      Parameters: Record<string, { Type: string; Default: string }>;
    };
    const [name, ...others] = Object.keys(Parameters).filter(
      (key) => key !== "BootstrapVersion",
    );
    assert(name !== undefined);

    expect(others).toEqual([]);
    expect(Parameters[name]).toEqual({
      Type: "AWS::SSM::Parameter::Value<String>",
      Default: "/flex/cross-region/shared/ci-origin-host",
    });
    built.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Origins: [Match.objectLike({ Id: "ci", DomainName: { Ref: name } })],
      }),
    });
  });

  // A job asks GitHub for a token with this audience, so each stage's function accepts only
  // tokens asked for it.
  it("builds the CloudFront Function for GitHub's tokens, with the stage's own address as their audience", () => {
    template().hasResourceProperties("AWS::CloudFront::Function", {
      Name: "shared-management-viewer-request",
      FunctionCode: Match.stringLikeRegexp(
        `https://token\\.actions\\.githubusercontent\\.com.*https://${PROD.shared.zone.name.replaceAll(".", String.raw`\.`)}/ci`,
      ),
    });
  });

  it("outputs the distribution's domain name, and exports nothing", () => {
    const built = template();
    const [distribution] = Object.keys(
      built.findResources("AWS::CloudFront::Distribution"),
    );

    expect(built.toJSON().Outputs).toEqual({
      DistributionDomainName: {
        Value: { "Fn::GetAtt": [distribution, "DomainName"] },
      },
    });
  });
});
