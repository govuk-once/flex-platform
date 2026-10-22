import { cdkApp } from "@repo/infra-constructs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import {
  DOMAIN_ONE,
  DOMAIN_TWO,
  FIXTURE_STAGES,
  NETWORK,
  synthesizedStage,
} from "../../test/helpers.ts";
import { buildApp } from "../build-app.ts";
import { selectTarget } from "../config/select-target.ts";
import {
  DOMAIN_REGION,
  DomainStack,
  domainStackName,
  edgeRoleArn,
} from "./domain.ts";
import { domainAccountStackName } from "./domain-account.ts";

const PROD = FIXTURE_STAGES[2];
const [DEV, STAGING, PROD_ENVIRONMENT] = PROD.environments;
const [MAIN, SECOND] = PROD_ENVIRONMENT.domainAccounts;

describe("DomainStack", () => {
  it("is one per domain an environment lists, in the domain account that hosts it", () => {
    const app = cdkApp();

    buildApp(app, PROD, selectTarget(PROD, "prod"));

    const assembly = app.synth();

    expect(assembly.stacks.map((stack) => stack.stackName).sort()).toEqual([
      "domain-prod-domain-one",
      "domain-prod-domain-two",
      "domain-prod-main-account",
      "domain-prod-second-account",
      "frontdoor-prod",
      "frontdoor-prod-edge-logs-eu-west-2",
    ]);
    expect(
      assembly.getStackByName("domain-prod-domain-one").environment,
    ).toMatchObject({ account: MAIN.account, region: DOMAIN_REGION });
    expect(
      assembly.getStackByName("domain-prod-domain-two").environment,
    ).toMatchObject({ account: SECOND.account, region: DOMAIN_REGION });
  });

  // Gating: a domain is built only where an environment lists it.
  it("builds no stack for a domain the environment doesn't list", () => {
    const assembly = synthesizedStage(PROD);
    const names = assembly.stacks.map((stack) => stack.stackName);

    expect(names).toContain(domainStackName(PROD_ENVIRONMENT, DOMAIN_TWO));
    expect(names).not.toContain(domainStackName(DEV, DOMAIN_TWO));
    expect(names).not.toContain(domainStackName(STAGING, DOMAIN_TWO));
  });

  it("deploys after its domain account's stack, which creates its host", () => {
    const assembly = synthesizedStage(PROD);
    const stack = assembly.getStackByName(
      domainStackName(PROD_ENVIRONMENT, DOMAIN_ONE),
    );

    expect(stack.dependencies.map(({ id }) => id)).toContain(
      assembly.getStackByName(domainAccountStackName(PROD_ENVIRONMENT, MAIN))
        .id,
    );
  });

  it("builds the domain from config, with the environment's edge role as its only caller", () => {
    const template = Template.fromStack(
      new DomainStack(cdkApp(), {
        environment: PROD_ENVIRONMENT,
        domain: DOMAIN_ONE,
      }),
    );

    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "domain-prod-domain-one",
      VpcConfig: {
        SubnetIds: NETWORK.isolated!.subnetIds,
        SecurityGroupIds: [NETWORK.isolated!.securityGroupId],
      },
    });
    template.hasResourceProperties("AWS::ApiGateway::RestApi", {
      Policy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "AllowFrontdoorRole",
            Principal: {
              AWS: `arn:aws:iam::${PROD_ENVIRONMENT.frontdoor.account}:root`,
            },
            Condition: {
              ArnEquals: {
                "aws:PrincipalArn": `arn:aws:iam::${PROD_ENVIRONMENT.frontdoor.account}:role/frontdoor-prod-edge`,
              },
            },
          }),
        ]),
      },
    });
    template.hasResourceProperties("AWS::ApiGateway::BasePathMapping", {
      DomainName: `domain-one.${MAIN.zone.name}`,
    });

    // The one parameter is CDK's bootstrap check. Nothing is read from a deployment.
    const { Parameters, Outputs } = template.toJSON() as {
      Parameters?: Record<string, unknown>;
      Outputs?: Record<string, unknown>;
    };

    expect(Object.keys(Parameters ?? {})).toEqual(["BootstrapVersion"]);
    expect(Outputs).toBeUndefined();
  });

  it("runs a public domain outside the VPC, in an account with no network", () => {
    const template = Template.fromStack(
      new DomainStack(cdkApp(), {
        environment: PROD_ENVIRONMENT,
        domain: DOMAIN_TWO,
      }),
    );

    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "domain-prod-domain-two",
      VpcConfig: Match.absent(),
    });
    template.hasResourceProperties("AWS::ApiGateway::BasePathMapping", {
      DomainName: `domain-two.${SECOND.zone.name}`,
    });
  });

  it("names its stack from the environment and the domain", () => {
    expect(domainStackName(PROD_ENVIRONMENT, DOMAIN_ONE)).toBe(
      "domain-prod-domain-one",
    );
  });

  it("names the edge's role as the frontdoor names it, in the frontdoor's account", () => {
    expect(edgeRoleArn(DEV)).toBe(
      `arn:aws:iam::${DEV.frontdoor.account}:role/frontdoor-dev-edge`,
    );
  });
});
