import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { cdkApp, FIXTURE_STAGES } from "../../test/helpers.ts";
import { buildApp } from "../build-app.ts";
import { selectTarget } from "../config/select-target.ts";
import { FrontdoorStack, frontdoorStackName } from "./frontdoor.ts";

const PROD = FIXTURE_STAGES[2];
const [DEV] = PROD.environments;

describe("FrontdoorStack", () => {
  it("is one per environment, in its frontdoor account, in us-east-1", () => {
    const app = cdkApp();
    buildApp(app, PROD, selectTarget(PROD, undefined));
    const assembly = app.synth();

    const frontdoors = assembly.stacks.filter((stack) =>
      stack.stackName.startsWith("frontdoor-"),
    );
    expect(frontdoors.map((stack) => stack.stackName).sort()).toEqual(
      PROD.environments.map(frontdoorStackName).sort(),
    );
    for (const environment of PROD.environments) {
      const stack = assembly.getStackByName(frontdoorStackName(environment));
      expect(stack.environment).toMatchObject({
        account: environment.frontdoorAccount,
        region: "us-east-1",
      });
    }
  });

  it("builds the edge from the environment's config, reading nothing back from a deployment", () => {
    const template = Template.fromStack(new FrontdoorStack(cdkApp(), DEV));

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Comment: `Flex front door, ${DEV.name}`,
        Origins: [Match.objectLike({ DomainName: `api.${DEV.domainName}` })],
      }),
    });
    template.hasResourceProperties("AWS::WAFv2::WebACL", {
      Name: `frontdoor-${DEV.name}`,
    });
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: `aws-waf-logs-frontdoor-${DEV.name}`,
      RetentionInDays: 365,
    });
    template.resourceCountIs("AWS::S3::Bucket", 0);
    template.resourceCountIs("AWS::Logs::Delivery", 1);

    // The one parameter is CDK's bootstrap check, not a value read from an account. The one
    // output is the name CloudFront gives the distribution, which nothing can derive.
    const { Parameters, Outputs } = template.toJSON() as {
      Parameters?: Record<string, unknown>;
      Outputs?: Record<string, unknown>;
    };
    expect(Object.keys(Parameters ?? {})).toEqual(["BootstrapVersion"]);
    expect(Object.keys(Outputs ?? {})).toEqual(["DistributionDomainName"]);
  });

  it("is built for one environment alone when the target names it", () => {
    const app = cdkApp();
    buildApp(app, PROD, selectTarget(PROD, "staging"));

    expect(app.synth().stacks.map((stack) => stack.stackName)).toEqual([
      "frontdoor-staging",
    ]);
  });

  it("names its stack from the environment alone, so stages compare directly", () => {
    expect(frontdoorStackName(DEV)).toBe("frontdoor-dev");
  });
});
