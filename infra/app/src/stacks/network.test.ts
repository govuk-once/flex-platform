import { cdkApp as cdkAppForTest } from "@repo/infra-constructs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { assert, describe, expect, it } from "vitest";

import {
  FIXTURE_STAGES,
  OWN_SECRET_GATEWAY,
  PRIVATE_API_GATEWAY,
  synthesizedStage,
  UDP,
} from "../../test/helpers.ts";
import type { DomainAccountConfig } from "../config/types.ts";
import { NetworkStack, networkStackName } from "./network.ts";

const PROD = FIXTURE_STAGES[2];
const [, , PROD_ENVIRONMENT] = PROD.environments;

// The dynamodb endpoint's own name, which AWS gives it when it is made.
const DYNAMODB_ADDRESS = {
  "Fn::Select": [
    1,
    {
      "Fn::Split": [
        ":",
        {
          "Fn::Select": [
            0,
            {
              "Fn::GetAtt": [
                Match.stringLikeRegexp("^EndpointsDynamoDb"),
                "DnsEntries",
              ],
            },
          ],
        },
      ],
    },
  ],
};

function build() {
  return new NetworkStack(cdkAppForTest(), {
    environment: PROD_ENVIRONMENT,
    domainAccount: PROD_ENVIRONMENT.domainAccounts[0],
  });
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
    const zones = Template.fromStack(build()).toJSON().Resources as Record<
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
    Template.fromStack(build()).hasResourceProperties("AWS::EC2::VPCEndpoint", {
      ServiceName: "com.amazonaws.eu-west-2.lambda",
      PolicyDocument: {
        Statement: [
          {
            Action: "lambda:InvokeFunction",
            Resource: `arn:aws:lambda:eu-west-2:${PROD_ENVIRONMENT.domainAccounts[0].account}:function:gateway-prod-*:live`,
          },
        ],
      },
    });
  });

  it("lets only the account's gateways read their upstreams' secrets and assume their roles, through the endpoints", () => {
    const template = Template.fromStack(build());
    const gatewayRoles = {
      ArnLike: {
        "aws:PrincipalArn": `arn:aws:iam::${PROD_ENVIRONMENT.domainAccounts[0].account}:role/gateway-prod-*-execution`,
      },
    };
    template.hasResourceProperties("AWS::EC2::VPCEndpoint", {
      ServiceName: "com.amazonaws.eu-west-2.secretsmanager",
      PolicyDocument: {
        Statement: [
          {
            Action: "secretsmanager:GetSecretValue",
            Resource: UDP.secret.arn,
            Condition: gatewayRoles,
          },
        ],
      },
    });
    template.hasResourceProperties("AWS::EC2::VPCEndpoint", {
      ServiceName: "com.amazonaws.eu-west-2.sts",
      PolicyDocument: {
        Statement: [
          {
            Action: "sts:AssumeRole",
            Resource: UDP.roleArns[0],
            Condition: gatewayRoles,
          },
        ],
      },
    });
  });

  it("names every secret a gateway's stack creates in the account by one pattern, and refuses every role when none is assumed", () => {
    const [main] = PROD_ENVIRONMENT.domainAccounts;
    const stack = new NetworkStack(cdkAppForTest(), {
      environment: PROD_ENVIRONMENT,
      domainAccount: {
        ...main,
        gateways: [
          OWN_SECRET_GATEWAY,
          { ...OWN_SECRET_GATEWAY, id: "uns", hostnames: ["api.uns.example"] },
        ],
      },
    });
    const own = Template.fromStack(stack);

    own.hasResourceProperties("AWS::EC2::VPCEndpoint", {
      ServiceName: "com.amazonaws.eu-west-2.secretsmanager",
      PolicyDocument: {
        Statement: [
          {
            Action: "secretsmanager:GetSecretValue",
            Resource: `arn:aws:secretsmanager:eu-west-2:${main.account}:secret:gateway-prod-*`,
          },
        ],
      },
    });
    own.hasResourceProperties("AWS::EC2::VPCEndpoint", {
      ServiceName: "com.amazonaws.eu-west-2.sts",
      PolicyDocument: {
        Statement: [{ Effect: "Deny", Action: "*", Resource: "*" }],
      },
    });
  });

  it("lets a principal of an upstream's account, and nothing else, invoke its private API through the execute-api endpoint, which only isolated gateways reach", () => {
    const [main] = PROD_ENVIRONMENT.domainAccounts;
    const stack = new NetworkStack(cdkAppForTest(), {
      environment: PROD_ENVIRONMENT,
      domainAccount: { ...main, gateways: [PRIVATE_API_GATEWAY] },
    });
    const withPrivateApi = Template.fromStack(stack);

    withPrivateApi.hasResourceProperties("AWS::EC2::VPCEndpoint", {
      ServiceName: "com.amazonaws.eu-west-2.execute-api",
      PolicyDocument: {
        Statement: [
          {
            Effect: "Allow",
            Action: "execute-api:Invoke",
            Resource: `${PRIVATE_API_GATEWAY.privateApiArns[0]}/*`,
            Condition: {
              StringEquals: { "aws:PrincipalAccount": ["200000000001"] },
            },
          },
        ],
      },
    });
    withPrivateApi.hasResourceProperties(
      "AWS::Route53Resolver::FirewallDomainList",
      { Domains: Match.arrayWith([PRIVATE_API_GATEWAY.hostnames[0]]) },
    );
    // One rule into the endpoint's group, from the isolated gateways' group.
    const into = withPrivateApi.findResources(
      "AWS::EC2::SecurityGroupIngress",
      {
        Properties: {
          GroupId: {
            "Fn::GetAtt": [
              Match.stringLikeRegexp("^EndpointsExecuteApiSecurityGroup"),
              "GroupId",
            ],
          },
        },
      },
    );
    expect(
      Object.values(into).map(
        (rule) =>
          (rule as { Properties: { Description: string } }).Properties
            .Description,
      ),
    ).toEqual(["HTTPS from isolated-gateway workloads"]);
  });

  it("names every gateway's private APIs in one statement, with each upstream's account once", () => {
    const [main] = PROD_ENVIRONMENT.domainAccounts;
    const sameUpstream = {
      ...PRIVATE_API_GATEWAY,
      id: "udp-other",
      hostnames: ["f6g7h8i9j0.execute-api.eu-west-2.amazonaws.com"],
      privateApiArns: ["arn:aws:execute-api:eu-west-2:200000000001:f6g7h8i9j0"],
    };
    const otherUpstream = {
      ...PRIVATE_API_GATEWAY,
      id: "uns",
      hostnames: ["k1l2m3n4o5.execute-api.eu-west-2.amazonaws.com"],
      roleArns: ["arn:aws:iam::300000000001:role/uns-consumer"],
      privateApiArns: ["arn:aws:execute-api:eu-west-2:300000000001:k1l2m3n4o5"],
    };
    const stack = new NetworkStack(cdkAppForTest(), {
      environment: PROD_ENVIRONMENT,
      domainAccount: {
        ...main,
        gateways: [otherUpstream, PRIVATE_API_GATEWAY, sameUpstream],
      },
    });

    Template.fromStack(stack).hasResourceProperties("AWS::EC2::VPCEndpoint", {
      ServiceName: "com.amazonaws.eu-west-2.execute-api",
      PolicyDocument: {
        Statement: [
          {
            Action: "execute-api:Invoke",
            Resource: [
              "arn:aws:execute-api:eu-west-2:200000000001:a1b2c3d4e5/*",
              "arn:aws:execute-api:eu-west-2:200000000001:f6g7h8i9j0/*",
              "arn:aws:execute-api:eu-west-2:300000000001:k1l2m3n4o5/*",
            ],
            Condition: {
              StringEquals: {
                "aws:PrincipalAccount": ["200000000001", "300000000001"],
              },
            },
          },
        ],
      },
    });
  });

  it("refuses everything through the execute-api endpoint when no gateway calls a private API", () => {
    Template.fromStack(build()).hasResourceProperties("AWS::EC2::VPCEndpoint", {
      ServiceName: "com.amazonaws.eu-west-2.execute-api",
      PolicyDocument: {
        Statement: [{ Effect: "Deny", Action: "*", Resource: "*" }],
      },
    });
  });

  it("lets gateways scan only the caller token's public keys through the dynamodb endpoint, resolve its own name, and find that name", () => {
    const template = Template.fromStack(build());
    template.hasResourceProperties("AWS::EC2::VPCEndpoint", {
      ServiceName: "com.amazonaws.eu-west-2.dynamodb",
      PrivateDnsEnabled: false,
      PolicyDocument: {
        Statement: [
          {
            Action: "dynamodb:Scan",
            Resource: `arn:aws:dynamodb:eu-west-2:${PROD_ENVIRONMENT.frontdoor.account}:table/frontdoor-prod-caller-token-public-keys`,
            Condition: {
              StringEquals: {
                "aws:PrincipalAccount":
                  PROD_ENVIRONMENT.domainAccounts[0].account,
              },
              ArnLike: {
                "aws:PrincipalArn": `arn:aws:iam::${PROD_ENVIRONMENT.domainAccounts[0].account}:role/gateway-prod-*-execution`,
              },
            },
          },
        ],
      },
    });
    template.hasResourceProperties("AWS::Route53Resolver::FirewallDomainList", {
      Domains: Match.arrayWith([DYNAMODB_ADDRESS]),
    });
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/flex/network/prod/endpoint-address/dynamodb",
      Value: DYNAMODB_ADDRESS,
    });
  });

  it("has no s3 endpoint", () => {
    expect(
      JSON.stringify(
        Template.fromStack(build()).findResources("AWS::EC2::VPCEndpoint"),
      ),
    ).not.toContain(".s3");
  });

  it("writes each endpoint's ID, for policies that hold a call to it", () => {
    const template = Template.fromStack(build());
    for (const service of [
      "dynamodb",
      "execute-api",
      "lambda",
      "secretsmanager",
      "sts",
    ]) {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: `/flex/network/prod/endpoint/${service}`,
      });
    }
  });

  it("writes a security group for each workload", () => {
    const template = Template.fromStack(build());
    for (const workload of ["domain", "isolated-gateway", "private-gateway"]) {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: `/flex/network/prod/security-group/${workload}`,
      });
    }
  });

  it("outputs each zone's NAT address, for upstreams to allowlist, and the endpoint a private API lets in", () => {
    const template = Template.fromStack(build());
    const outputs = template.findOutputs("*");

    expect(Object.keys(outputs).sort()).toEqual([
      "ExecuteApiEndpointId",
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
      const network = Template.fromStack(build());
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
      const priority = (name: string) => {
        const association = associations.find(({ Name }) => Name === name);
        assert(typeof association?.Priority === "number");
        return association.Priority;
      };

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
      // Fails closed by default, which is set by nothing: see the DnsFirewall construct.
      network.resourceCountIs("AWS::Route53Resolver::FirewallConfig", 0);
      network.resourceCountIs(
        "AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation",
        1,
      );
    });

    it("allows the endpoints' names and every name its account's gateways declare", () => {
      Template.fromStack(build()).hasResourceProperties(
        "AWS::Route53Resolver::FirewallDomainList",
        {
          Name: "network-prod-dns-allowed",
          Domains: [
            "api.udp.example",
            "auth.udp.example",
            "lambda.eu-west-2.amazonaws.com",
            "secretsmanager.eu-west-2.amazonaws.com",
            "sts.eu-west-2.amazonaws.com",
            DYNAMODB_ADDRESS,
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
        ...UDP,
        hostnames: ["api.udp.example", "auth.shared.example"],
      };
      const uns = {
        ...UDP,
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
            "lambda.eu-west-2.amazonaws.com",
            "secretsmanager.eu-west-2.amazonaws.com",
            "sts.eu-west-2.amazonaws.com",
            DYNAMODB_ADDRESS,
          ],
        },
      );
    });
  });
});
