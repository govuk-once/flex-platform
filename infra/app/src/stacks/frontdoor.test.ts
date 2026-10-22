import { readFileSync } from "node:fs";
import path from "node:path";

import { buildOriginRequestFunction } from "@repo/frontdoor-origin-request";
import { cdkApp } from "@repo/infra-constructs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../../test/helpers.ts";
import { buildApp } from "../build-app.ts";
import { selectTarget } from "../config/select-target.ts";
import { FrontdoorStack, frontdoorStackName } from "./frontdoor.ts";

const PROD = FIXTURE_STAGES[2];
const [DEV, , PROD_ENVIRONMENT] = PROD.environments;
const [MAIN, SECOND] = PROD_ENVIRONMENT.domainAccounts;

describe("FrontdoorStack", () => {
  it("is one per environment, in its frontdoor account, in us-east-1", () => {
    const assembly = synthesizedStage(PROD);

    const names = PROD.environments.map(frontdoorStackName);
    const frontdoors = assembly.stacks.filter((stack) =>
      names.includes(stack.stackName),
    );
    expect(frontdoors).toHaveLength(names.length);
    for (const environment of PROD.environments) {
      const stack = assembly.getStackByName(frontdoorStackName(environment));
      expect(stack.environment).toMatchObject({
        account: environment.frontdoor.account,
        region: "us-east-1",
      });
      expect(stack.terminationProtection).toBe(true);
    }
  });

  it("builds the edge from the environment's config, reading nothing back from a deployment", () => {
    const template = Template.fromStack(new FrontdoorStack(cdkApp(), DEV));

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Comment: `Flex front door, ${DEV.name}`,
      }),
    });
    template.hasResourceProperties("AWS::WAFv2::WebACL", {
      Name: `frontdoor-${DEV.name}-web-acl`,
    });
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: `aws-waf-logs-frontdoor-${DEV.name}-web-acl`,
      RetentionInDays: 365,
    });
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: `/aws/cloudfront/function/frontdoor-${DEV.name}-viewer-request`,
      RetentionInDays: 365,
    });
    // The default origin, and no other.
    template.resourceCountIs("AWS::S3::Bucket", 1);
    template.resourceCountIs("AWS::Logs::Delivery", 1);
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: `frontdoor-${DEV.name}-origin-request`,
      LoggingConfig: {
        LogGroup: `/flex/frontdoor/${DEV.name}/origin-request`,
      },
    });
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: `frontdoor-${DEV.name}-edge`,
    });

    // The one parameter is CDK's bootstrap check, not a value read from an account. The one
    // output is the name CloudFront gives the distribution, which nothing can derive.
    const { Parameters, Outputs } = template.toJSON() as {
      Parameters?: Record<string, unknown>;
      Outputs?: Record<string, unknown>;
    };
    expect(Object.keys(Parameters ?? {})).toEqual(["BootstrapVersion"]);
    expect(Object.keys(Outputs ?? {})).toEqual(["DistributionDomainName"]);
  });

  // Lambda@Edge has no environment variables, so the routing map is baked into its bundle.
  it("routes each domain the environment hosts to its host under its account's zone", () => {
    const app = cdkApp();
    const template = Template.fromStack(
      new FrontdoorStack(app, PROD_ENVIRONMENT),
    );
    const [resource] = Object.values(
      template.findResources("AWS::Lambda::Function", {
        Properties: { FunctionName: "frontdoor-prod-origin-request" },
      }),
    );
    // CDK stages the asset in the app's output directory, named by the hash its key carries.
    const key = (resource?.Properties as { Code: { S3Key: string } }).Code
      .S3Key;
    const code = readFileSync(
      path.join(app.outdir, `asset.${key.replace(/\.zip$/, "")}`, "index.js"),
      "utf8",
    );

    expect(code).toBe(
      buildOriginRequestFunction({
        issuers: PROD_ENVIRONMENT.frontdoor.issuers,
        routes: {
          "domain-one": `domain-one.${MAIN.zone.name}`,
          "domain-two": `domain-two.${SECOND.zone.name}`,
        },
      }),
    );
  });

  it("is built for one environment alone when the target names it, with its domains", () => {
    const app = cdkApp();
    buildApp(app, PROD, selectTarget(PROD, "staging"));

    // In deploy order: each stack after the stacks it depends on.
    expect(app.synth().stacks.map((stack) => stack.stackName)).toEqual([
      "domain-staging-main-account",
      "frontdoor-staging-edge-logs-eu-west-2",
      "domain-staging-domain-one",
      "frontdoor-staging",
    ]);
  });

  it("names its stack from the environment alone, so stages compare directly", () => {
    expect(frontdoorStackName(DEV)).toBe("frontdoor-dev");
  });
});
