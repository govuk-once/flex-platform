import { cdkApp as cdkAppForTest } from "@repo/infra-constructs";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../../test/helpers.ts";
import { NetworkStack, networkStackName } from "./network.ts";

const PROD = FIXTURE_STAGES[2];
const [, , PROD_ENVIRONMENT] = PROD.environments;

function template(): Template {
  const assembly = synthesizedStage(PROD);
  return Template.fromJSON(
    assembly.getStackByName(
      networkStackName(PROD_ENVIRONMENT, PROD_ENVIRONMENT.domainAccounts[0]),
    ).template as Record<string, unknown>,
  );
}

describe("NetworkStack", () => {
  it("is one per domain account, in its account, in eu-west-2, protected from deletion", () => {
    const assembly = synthesizedStage(PROD);

    for (const environment of PROD.environments) {
      for (const domainAccount of environment.domainAccounts) {
        const stack = assembly.getStackByName(
          networkStackName(environment, domainAccount),
        );
        expect(stack.environment).toMatchObject({
          account: domainAccount.account,
          region: "eu-west-2",
        });
        expect(stack.terminationProtection).toBe(true);
        expect(stack.dependencies.map(({ id }) => id)).toEqual([
          expect.stringMatching(/\.assets$/),
        ]);
      }
    }
  });

  it("lays out the zones its domain account's config lists", () => {
    const zones = template().toJSON().Resources as Record<
      string,
      { Type: string; Properties: { AvailabilityZone?: string } }
    >;
    const used = new Set(
      Object.values(zones)
        .filter(({ Type }) => Type === "AWS::EC2::Subnet")
        .map(({ Properties }) => Properties.AvailabilityZone),
    );

    expect([...used].sort()).toEqual(
      [...PROD_ENVIRONMENT.domainAccounts[0].network.availabilityZones].sort(),
    );
  });

  it("lets its domains invoke only the environment's gateways", () => {
    template().hasResourceProperties("AWS::EC2::VPCEndpoint", {
      ServiceName: "com.amazonaws.eu-west-2.lambda",
      PolicyDocument: {
        Statement: [
          {
            Action: "lambda:InvokeFunction",
            Resource: `arn:aws:lambda:eu-west-2:${PROD_ENVIRONMENT.domainAccounts[0].account}:function:gateway-prod-*`,
          },
        ],
      },
    });
  });

  it("writes a security group for each workload", () => {
    for (const workload of ["domain", "isolated-gateway", "private-gateway"]) {
      template().hasResourceProperties("AWS::SSM::Parameter", {
        Name: `/flex/network/prod/security-group/${workload}`,
      });
    }
  });

  it("outputs each zone's NAT address, for upstreams to allowlist", () => {
    const outputs = template().findOutputs("*");

    expect(Object.keys(outputs).sort()).toEqual([
      expect.stringMatching(/^NatAddresseuwest2a/),
      expect.stringMatching(/^NatAddresseuwest2b/),
      expect.stringMatching(/^NatAddresseuwest2c/),
    ]);
  });

  it("names its stack from the environment and the domain account", () => {
    expect(
      networkStackName(PROD_ENVIRONMENT, PROD_ENVIRONMENT.domainAccounts[1]),
    ).toBe("network-prod-second");
  });

  it("refuses zones it has no layout for", () => {
    expect(
      () =>
        new NetworkStack(cdkAppForTest(), {
          environment: PROD_ENVIRONMENT,
          domainAccount: {
            ...PROD_ENVIRONMENT.domainAccounts[0],
            network: { availabilityZones: ["eu-west-2a", "eu-west-2d"] },
          },
        }),
    ).toThrow('"eu-west-2d" is not an availability zone');
  });
});
