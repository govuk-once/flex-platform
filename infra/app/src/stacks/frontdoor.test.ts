import { cdkApp } from "@repo/infra-constructs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../../test/helpers.ts";
import { buildApp } from "../build-app.ts";
import { domainName } from "../config/domain-name.ts";
import { selectTarget } from "../config/select-target.ts";
import type { DomainConfig, StageConfig } from "../config/types.ts";
import { domainStackName } from "./domain.ts";
import {
  domainRoutes,
  FrontdoorStack,
  frontdoorStackName,
} from "./frontdoor.ts";

const PROD = FIXTURE_STAGES[2];
const [DEV] = PROD.environments;

// PROD, with one domain disabled in every environment that hosts it.
function disabling(domain: string): StageConfig {
  return {
    ...PROD,
    environments: PROD.environments.map((environment) => ({
      ...environment,
      domainAccounts: environment.domainAccounts.map((domainAccount) => ({
        ...domainAccount,
        domains: domainAccount.domains.map((entry) =>
          domainName(entry) === domain
            ? { name: domain, disabled: true as const }
            : entry,
        ),
      })),
    })),
  };
}

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

  it("is built for one environment alone when the target names it", () => {
    const app = cdkApp();
    buildApp(app, PROD, selectTarget(PROD, "staging"));

    expect(app.synth().stacks.map((stack) => stack.stackName)).toEqual([
      "domainaccount-staging-main",
      "frontdoor-staging-edge-logs-eu-west-2",
      "network-staging-main",
      "domain-staging-domain-a",
      "domain-staging-domain-b",
      "frontdoor-staging",
    ]);
  });

  it("routes each domain the environment hosts to its host, whichever account and order config lists it in", () => {
    const [, , prodEnvironment] = PROD.environments;
    const [main, second] = prodEnvironment.domainAccounts;
    const routes = domainRoutes({
      ...prodEnvironment,
      domainAccounts: [
        { ...main, domains: ["domain-b"] },
        { ...second, domains: ["domain-a"] },
      ],
    });

    expect(routes).toEqual({
      "domain-a": `domain-a.${second.zone.name}`,
      "domain-b": `domain-b.${main.zone.name}`,
    });
    expect(Object.keys(routes)).toEqual(["domain-a", "domain-b"]);
  });

  it("routes nothing to a disabled domain, and nothing at all when every domain is", () => {
    const [, , prodEnvironment] = PROD.environments;
    const [main] = prodEnvironment.domainAccounts;
    const routesWith = (domains: readonly DomainConfig[]) =>
      domainRoutes({
        ...prodEnvironment,
        domainAccounts: [{ ...main, domains }],
      });
    const routes = {
      "domain-a": `domain-a.${main.zone.name}`,
      "domain-b": `domain-b.${main.zone.name}`,
    };

    expect(routesWith(["domain-a", "domain-b"])).toEqual(routes);
    expect(
      routesWith(["domain-a", { name: "domain-b", disabled: true }]),
    ).toEqual({ "domain-a": routes["domain-a"] });
    expect(
      routesWith([
        { name: "domain-a", disabled: true },
        { name: "domain-b", disabled: true },
      ]),
    ).toEqual({});
  });

  it("keeps a disabled domain's stack and its dependency, unchanged, so enabling it again recreates nothing", () => {
    const synth = (stage: StageConfig) => {
      const app = cdkApp();
      buildApp(app, stage, selectTarget(stage, "staging"));
      return app.synth();
    };
    const [, staging] = PROD.environments;
    const name = domainStackName(staging, "domain-b");
    const before = synth(PROD);
    const after = synth(disabling("domain-b"));

    expect(after.getStackByName(name).template).toEqual(
      before.getStackByName(name).template,
    );
    expect(
      after
        .getStackByName(frontdoorStackName(staging))
        .dependencies.map(({ id }) => id),
    ).toContain(name);
  });

  it("names its stack from the environment alone, so stages compare directly", () => {
    expect(frontdoorStackName(DEV)).toBe("frontdoor-dev");
  });
});
