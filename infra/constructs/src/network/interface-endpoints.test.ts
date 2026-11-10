import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT,
  buildNetwork,
  KEYS_OBJECT,
  UPSTREAM_ROLE,
  UPSTREAM_SECRET,
  ZonedStack,
} from "../../test/network.ts";
import { cdkApp } from "../cdk-app.ts";
import { InterfaceEndpoints } from "./interface-endpoints.ts";
import { NatAddresses } from "./nat-addresses.ts";
import { NetworkVpc } from "./vpc.ts";

const GATEWAY_ROLES = `arn:aws:iam::${ACCOUNT}:role/gateway-sandbox-*-execution`;

function endpoint(
  service: string,
  Action: string,
  Resource: unknown,
  resourceAccount?: string,
  principals?: string,
) {
  return {
    ServiceName: `com.amazonaws.eu-west-2.${service}`,
    VpcEndpointType: "Interface",
    PrivateDnsEnabled: true,
    SubnetIds: [
      { Ref: Match.stringLikeRegexp("^NetworkIsolatedeuwest2aSubnet") },
      { Ref: Match.stringLikeRegexp("^NetworkIsolatedeuwest2bSubnet") },
    ],
    PolicyDocument: {
      Statement: [
        {
          Effect: "Allow",
          Principal: { AWS: "*" },
          Action,
          Resource,
          Condition: {
            StringEquals: {
              "aws:PrincipalAccount": ACCOUNT,
              ...(resourceAccount !== undefined && {
                "aws:ResourceAccount": [resourceAccount],
              }),
            },
            ...(principals !== undefined && {
              ArnLike: { "aws:PrincipalArn": principals },
            }),
          },
        },
      ],
    },
  };
}

describe("InterfaceEndpoints", () => {
  it.each([
    [
      "lambda",
      "lambda:InvokeFunction",
      `arn:aws:lambda:eu-west-2:${ACCOUNT}:function:gateway-sandbox-*`,
    ],
    [
      "secretsmanager",
      "secretsmanager:GetSecretValue",
      UPSTREAM_SECRET,
      undefined,
      // Only gateways read secrets and assume roles, so nothing else in the account may.
      GATEWAY_ROLES,
    ],
    ["sts", "sts:AssumeRole", UPSTREAM_ROLE, undefined, GATEWAY_ROLES],
    [
      "s3",
      "s3:GetObject",
      `arn:aws:s3:::${KEYS_OBJECT.bucket}/${KEYS_OBJECT.key}`,
      // Bucket names are global, so the bucket's owner is named too.
      KEYS_OBJECT.account,
    ],
  ])(
    "has a %s endpoint in the isolated subnets, for this account, one action and what it names",
    (
      service,
      action,
      resource,
      resourceAccount?: string,
      principals?: string,
    ) => {
      buildNetwork().template.hasResourceProperties(
        "AWS::EC2::VPCEndpoint",
        endpoint(service, action, resource, resourceAccount, principals),
      );
    },
  );

  it("has no other endpoint", () => {
    buildNetwork().template.resourceCountIs("AWS::EC2::VPCEndpoint", 4);
  });

  it("gives each endpoint a group of its own, which lets nothing out and lets in only workloads", () => {
    const { template } = buildNetwork();
    const groups = Object.values(
      template.findResources("AWS::EC2::SecurityGroup", {
        Properties: {
          GroupDescription: Match.stringLikeRegexp("interface endpoint$"),
        },
      }),
    ) as { Properties: Record<string, unknown> }[];

    expect(groups).toHaveLength(4);
    for (const group of groups) {
      expect(group.Properties).not.toHaveProperty("SecurityGroupIngress");
      expect(group.Properties.SecurityGroupEgress).toEqual([
        expect.objectContaining({ CidrIp: "255.255.255.255/32" }),
      ]);
    }
  });

  it("gives the names the SDK calls each endpoint's API at, for the DNS allowlist", () => {
    const { stack } = buildNetwork();
    const endpoints = stack.node.findChild("Endpoints") as InterfaceEndpoints;

    expect(endpoints.hostnames).toEqual([
      "lambda.eu-west-2.amazonaws.com",
      "secretsmanager.eu-west-2.amazonaws.com",
      "sts.eu-west-2.amazonaws.com",
      `${KEYS_OBJECT.bucket}.s3.eu-west-2.amazonaws.com`,
    ]);
  });

  it("answers the VPC's own lookups of S3's names, with no gateway endpoint beside it", () => {
    buildNetwork().template.hasResourceProperties("AWS::EC2::VPCEndpoint", {
      ServiceName: "com.amazonaws.eu-west-2.s3",
      DnsOptions: { PrivateDnsOnlyForInboundResolverEndpoint: "AllResolvers" },
    });
  });

  it("refuses everything through an endpoint with nothing to name", () => {
    const zones = ["eu-west-2a", "eu-west-2b"];
    const stack = new ZonedStack(cdkApp(), zones);
    const { vpc, subnets } = new NetworkVpc(stack, "Network", {
      environment: "sandbox",
      zones,
      natAddresses: new NatAddresses(stack, "NatAddresses", {
        environment: "sandbox",
        zones,
      }),
    });
    new InterfaceEndpoints(stack, "Endpoints", {
      vpc,
      subnets: subnets.isolated,
      invokableFunctions: "gateway-sandbox-*",
      readableObjects: [],
      readableSecrets: [],
      assumableRoles: [],
      gatewayRoles: "gateway-sandbox-*-execution",
    });

    for (const service of ["secretsmanager", "sts", "s3"]) {
      Template.fromStack(stack).hasResourceProperties("AWS::EC2::VPCEndpoint", {
        ServiceName: `com.amazonaws.eu-west-2.${service}`,
        PolicyDocument: {
          Statement: [
            {
              Effect: "Deny",
              Principal: { AWS: "*" },
              Action: "*",
              Resource: "*",
            },
          ],
        },
      });
    }
  });
});
