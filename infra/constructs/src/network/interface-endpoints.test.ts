import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ACCOUNT, buildNetwork, KEYS_OBJECT } from "../../test/network.ts";
import type { InterfaceEndpoints } from "./interface-endpoints.ts";

function endpoint(
  service: string,
  Action: string,
  Resource: unknown,
  resourceAccount?: string,
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
              // An endpoint that names no resource is held to this account's.
              ...(Resource === "*" && { "aws:ResourceAccount": ACCOUNT }),
              ...(resourceAccount !== undefined && {
                "aws:ResourceAccount": [resourceAccount],
              }),
            },
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
    ["secretsmanager", "secretsmanager:GetSecretValue", "*"],
    ["sts", "sts:AssumeRole", "*"],
    [
      "s3",
      "s3:GetObject",
      `arn:aws:s3:::${KEYS_OBJECT.bucket}/${KEYS_OBJECT.key}`,
      // Bucket names are global, so the bucket's owner is named too.
      KEYS_OBJECT.account,
    ],
  ])(
    "has a %s endpoint in the isolated subnets, for this account and one action",
    (service, action, resource, resourceAccount?: string) => {
      buildNetwork().template.hasResourceProperties(
        "AWS::EC2::VPCEndpoint",
        endpoint(service, action, resource, resourceAccount),
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
});
