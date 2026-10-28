import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { buildNetwork } from "../../test/network.ts";

type Template = ReturnType<typeof buildNetwork>["template"];
type Rule = Record<string, unknown>;

function rules(template: Template, type: string, props = {}): Rule[] {
  const found = template.findResources(type, props) as Record<
    string,
    { Properties: Rule }
  >;
  return Object.values(found).map(({ Properties }) => Properties);
}

// A group's logical ID without its hash.
function group(reference: unknown): string {
  const [id] = (reference as { "Fn::GetAtt": [string] })["Fn::GetAtt"];
  return id.replace(/[0-9A-F]{8}$/, "");
}

function egress(template: Template, from: string): unknown[] {
  return rules(template, "AWS::EC2::SecurityGroupEgress", {
    Properties: {
      GroupId: {
        "Fn::GetAtt": [Match.stringLikeRegexp(`^${from}`), "GroupId"],
      },
    },
  }).map(({ DestinationSecurityGroupId }) => DestinationSecurityGroupId);
}

describe("WorkloadSecurityGroup", () => {
  it("lets an isolated workload out only to its endpoints, on TCP 443", () => {
    const { template } = buildNetwork();

    // CDK's rule that matches nothing, which keeps EC2's default allow-all egress off the group.
    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      GroupDescription: "domain workloads, isolated tier",
      SecurityGroupIngress: Match.absent(),
      SecurityGroupEgress: [
        Match.objectLike({ CidrIp: "255.255.255.255/32", IpProtocol: "icmp" }),
      ],
    });
    expect(egress(template, "DomainSecurityGroup")).toEqual([
      {
        "Fn::GetAtt": [
          expect.stringMatching("^EndpointsLambdaSecurityGroup"),
          "GroupId",
        ],
      },
    ]);
  });

  it("lets a private workload out to its endpoints and through NAT, on TCP 443", () => {
    const { template } = buildNetwork();

    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      GroupDescription: "private-gateway workloads, private tier",
      SecurityGroupIngress: Match.absent(),
      SecurityGroupEgress: [
        {
          CidrIp: "0.0.0.0/0",
          IpProtocol: "tcp",
          FromPort: 443,
          ToPort: 443,
          Description: "TCP 443 out through NAT",
        },
      ],
    });
    expect(egress(template, "PrivateGatewaySecurityGroup")).toEqual([
      {
        "Fn::GetAtt": [
          expect.stringMatching("^EndpointsSecretsManagerSecurityGroup"),
          "GroupId",
        ],
      },
      {
        "Fn::GetAtt": [
          expect.stringMatching("^EndpointsStsSecurityGroup"),
          "GroupId",
        ],
      },
    ]);
  });

  it("is let into each of its endpoints, and no other", () => {
    const { template } = buildNetwork();
    const ingress = rules(template, "AWS::EC2::SecurityGroupIngress").map(
      ({ GroupId, SourceSecurityGroupId, FromPort, ToPort }) => [
        group(GroupId),
        group(SourceSecurityGroupId),
        FromPort,
        ToPort,
      ],
    );

    expect(ingress).toEqual(
      expect.arrayContaining([
        ["EndpointsLambdaSecurityGroup", "DomainSecurityGroup", 443, 443],
        [
          "EndpointsSecretsManagerSecurityGroup",
          "PrivateGatewaySecurityGroup",
          443,
          443,
        ],
        ["EndpointsStsSecurityGroup", "PrivateGatewaySecurityGroup", 443, 443],
      ]),
    );
    expect(ingress).toHaveLength(3);
  });
});
