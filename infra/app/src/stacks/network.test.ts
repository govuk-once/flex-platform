import { cdkApp as cdkAppForTest } from "@repo/infra-constructs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import {
  FIXTURE_STAGES,
  GATEWAYS,
  synthesizedStage,
} from "../../test/helpers.ts";
import type { DomainAccountConfig } from "../config/types.ts";
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

  it("lets gateways read only their own secrets, and assume only their upstreams' roles, through the endpoints", () => {
    const [udp] = PROD_ENVIRONMENT.domainAccounts[0].gateways;
    if (udp === undefined || udp.secret === "create") {
      throw new Error("The fixture's gateway holds an upstream's secret");
    }
    template().hasResourceProperties("AWS::EC2::VPCEndpoint", {
      ServiceName: "com.amazonaws.eu-west-2.secretsmanager",
      PolicyDocument: {
        Statement: [
          {
            Action: "secretsmanager:GetSecretValue",
            Resource: udp.secret.arn,
          },
        ],
      },
    });
    template().hasResourceProperties("AWS::EC2::VPCEndpoint", {
      ServiceName: "com.amazonaws.eu-west-2.sts",
      PolicyDocument: {
        Statement: [{ Action: "sts:AssumeRole", Resource: udp.roleArns[0] }],
      },
    });
  });

  it("lets gateways read only the caller token's public keys through the s3 endpoint, and resolve the bucket's name", () => {
    const bucket = `frontdoor-prod-keys-${PROD_ENVIRONMENT.frontdoor.account}`;
    template().hasResourceProperties("AWS::EC2::VPCEndpoint", {
      ServiceName: "com.amazonaws.eu-west-2.s3",
      PolicyDocument: {
        Statement: [
          {
            Action: "s3:GetObject",
            Resource: `arn:aws:s3:::${bucket}/caller-token-keys.json`,
            Condition: {
              StringEquals: {
                "aws:ResourceAccount": [PROD_ENVIRONMENT.frontdoor.account],
              },
            },
          },
        ],
      },
    });
    template().hasResourceProperties(
      "AWS::Route53Resolver::FirewallDomainList",
      {
        Domains: Match.arrayWith([`${bucket}.s3.eu-west-2.amazonaws.com`]),
      },
    );
  });

  it("writes each endpoint's ID, for policies that hold a call to it", () => {
    for (const service of ["lambda", "s3", "secretsmanager", "sts"]) {
      template().hasResourceProperties("AWS::SSM::Parameter", {
        Name: `/flex/network/prod/endpoint/${service}`,
      });
    }
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

  describe("DNS Firewall", () => {
    it("filters, fails closed and logs queries", () => {
      const network = template();
      const rules = Object.values(
        network.findResources("AWS::Route53Resolver::FirewallRuleGroup"),
      ).map(
        ({ Properties }) =>
          (Properties as { FirewallRules: Record<string, unknown>[] })
            .FirewallRules,
      );
      const associations = Object.values(
        network.findResources(
          "AWS::Route53Resolver::FirewallRuleGroupAssociation",
        ),
      ).map(({ Properties }) => Properties as Record<string, unknown>);
      const priority = (name: string) =>
        associations.find(({ Name }) => Name === name)?.Priority as number;

      expect(rules).toContainEqual([
        expect.objectContaining({ Action: "ALLOW" }),
      ]);
      expect(rules).toContainEqual([
        expect.objectContaining({
          Action: "BLOCK",
          BlockResponse: "NXDOMAIN",
        }),
      ]);
      expect(priority("network-prod-dns-allow")).toBeLessThan(
        priority("network-prod-dns-block"),
      );
      network.hasResourceProperties(
        "AWS::Route53Resolver::FirewallDomainList",
        {
          Domains: ["*"],
        },
      );
      network.hasResourceProperties("AWS::Route53Resolver::FirewallConfig", {
        FirewallFailOpen: "DISABLED",
      });
      network.resourceCountIs(
        "AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation",
        1,
      );
    });

    it("allows the endpoints' names and every name its account's gateways declare", () => {
      template().hasResourceProperties(
        "AWS::Route53Resolver::FirewallDomainList",
        {
          Name: "network-prod-dns-allowed",
          Domains: [
            "api.udp.example",
            "auth.udp.example",
            `frontdoor-prod-keys-${PROD_ENVIRONMENT.frontdoor.account}.s3.eu-west-2.amazonaws.com`,
            "lambda.eu-west-2.amazonaws.com",
            "secretsmanager.eu-west-2.amazonaws.com",
            "sts.eu-west-2.amazonaws.com",
          ],
        },
      );
    });

    it("removes a gateway's own names with it, keeping a name another gateway still declares", () => {
      const allowed = (gateways: DomainAccountConfig["gateways"]) => {
        const stack = new NetworkStack(cdkAppForTest(), {
          environment: PROD_ENVIRONMENT,
          domainAccount: { ...PROD_ENVIRONMENT.domainAccounts[0], gateways },
        });
        const [list] = Object.values(
          Template.fromStack(stack).findResources(
            "AWS::Route53Resolver::FirewallDomainList",
            { Properties: { Name: "network-prod-dns-allowed" } },
          ),
        ) as { Properties: { Domains: string[] } }[];
        return list?.Properties.Domains;
      };
      const udp = {
        ...GATEWAYS[0]!,
        hostnames: ["api.udp.example", "auth.shared.example"],
      };
      const uns = {
        ...GATEWAYS[0]!,
        id: "uns",
        hostnames: ["api.uns.example", "auth.shared.example"],
      };

      expect(allowed([udp, uns])).toEqual(
        expect.arrayContaining([
          "api.udp.example",
          "api.uns.example",
          "auth.shared.example",
        ]),
      );
      const remaining = allowed([udp]);
      expect(remaining).toContain("api.udp.example");
      expect(remaining).toContain("auth.shared.example");
      expect(remaining).not.toContain("api.uns.example");
    });

    it("allows only the endpoints' names in an account with no gateways", () => {
      const stack = new NetworkStack(cdkAppForTest(), {
        environment: PROD_ENVIRONMENT,
        domainAccount: { ...PROD_ENVIRONMENT.domainAccounts[0], gateways: [] },
      });

      Template.fromStack(stack).hasResourceProperties(
        "AWS::Route53Resolver::FirewallDomainList",
        {
          Name: "network-prod-dns-allowed",
          Domains: [
            `frontdoor-prod-keys-${PROD_ENVIRONMENT.frontdoor.account}.s3.eu-west-2.amazonaws.com`,
            "lambda.eu-west-2.amazonaws.com",
            "secretsmanager.eu-west-2.amazonaws.com",
            "sts.eu-west-2.amazonaws.com",
          ],
        },
      );
    });
  });
});
