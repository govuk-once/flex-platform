import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ACCOUNT, buildNetwork } from "../../test/network.ts";

function endpoint(service: string, Action: string, Resource: unknown) {
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
              "aws:ResourceAccount": ACCOUNT,
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
  ])(
    "has a %s endpoint in the isolated subnets, for this account and one action",
    (service, action, resource) => {
      buildNetwork().template.hasResourceProperties(
        "AWS::EC2::VPCEndpoint",
        endpoint(service, action, resource),
      );
    },
  );

  it("has no other endpoint", () => {
    buildNetwork().template.resourceCountIs("AWS::EC2::VPCEndpoint", 3);
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

    expect(groups).toHaveLength(3);
    for (const group of groups) {
      expect(group.Properties).not.toHaveProperty("SecurityGroupIngress");
      expect(group.Properties.SecurityGroupEgress).toEqual([
        expect.objectContaining({ CidrIp: "255.255.255.255/32" }),
      ]);
    }
  });
});
