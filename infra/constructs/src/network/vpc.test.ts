import { Stack } from "aws-cdk-lib";
import type { Template } from "aws-cdk-lib/assertions";
import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { buildNetwork } from "../../test/network.ts";
import { cdkApp } from "../cdk-app.ts";
import { ZONE_LAYOUT } from "./layout.ts";
import { NatAddresses } from "./nat-addresses.ts";
import { NetworkVpc } from "./vpc.ts";

type Resources = Record<
  string,
  {
    Type: string;
    Properties?: Record<string, unknown>;
    DeletionPolicy?: string;
  }
>;

function resources(template: Template, type: string): Resources {
  return template.findResources(type) as Resources;
}

// Each subnet's logical ID and range.
function subnetRanges(template: Template): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(resources(template, "AWS::EC2::Subnet")).map(
      ([id, subnet]) => [id, subnet.Properties?.CidrBlock],
    ),
  );
}

describe("NetworkVpc", () => {
  it("gives each zone's subnets the ranges the layout does", () => {
    const { template } = buildNetwork([
      "eu-west-2a",
      "eu-west-2b",
      "eu-west-2c",
    ]);

    for (const [zone, layout] of Object.entries(ZONE_LAYOUT)) {
      for (const tier of ["public", "private", "isolated"] as const) {
        template.hasResourceProperties("AWS::EC2::Subnet", {
          AvailabilityZone: zone,
          CidrBlock: layout[tier],
        });
      }
    }
    template.resourceCountIs("AWS::EC2::Subnet", 9);
    for (const subnet of Object.values(
      resources(template, "AWS::EC2::Subnet"),
    )) {
      expect(subnet.Properties?.MapPublicIpOnLaunch).not.toBe(true);
    }
  });

  // A subnet whose ID or range changes is replaced, and so is everything in it.
  it("leaves a zone's subnets as they are when another zone is added", () => {
    const two = subnetRanges(
      buildNetwork(["eu-west-2a", "eu-west-2b"]).template,
    );
    const three = subnetRanges(
      buildNetwork(["eu-west-2a", "eu-west-2b", "eu-west-2c"]).template,
    );

    expect(Object.keys(two)).toHaveLength(6);
    expect(three).toMatchObject(two);
  });

  it("builds the same template whatever order config lists the zones in", () => {
    expect(
      buildNetwork(["eu-west-2b", "eu-west-2a"]).template.toJSON(),
    ).toEqual(buildNetwork(["eu-west-2a", "eu-west-2b"]).template.toJSON());
  });

  it("routes nothing out of an isolated subnet, and a private one through its own zone's NAT gateway", () => {
    const { template } = buildNetwork();
    // Each route as its table and its target, by logical ID without the hash.
    const unhashed = (reference: unknown) =>
      (reference as { Ref: string }).Ref.replace(/[0-9A-F]{8}$/, "");
    const routes = Object.values(resources(template, "AWS::EC2::Route")).map(
      ({ Properties = {} }) => [
        Properties.DestinationCidrBlock,
        unhashed(Properties.RouteTableId),
        unhashed(Properties.GatewayId ?? Properties.NatGatewayId),
      ],
    );

    expect(routes).toEqual(
      expect.arrayContaining(
        ["euwest2a", "euwest2b"].flatMap((zone) => [
          [
            "0.0.0.0/0",
            `NetworkPublic${zone}RouteTable`,
            "NetworkInternetGateway",
          ],
          [
            "0.0.0.0/0",
            `NetworkPrivate${zone}RouteTable`,
            `NetworkPublic${zone}NATGateway`,
          ],
        ]),
      ),
    );
    expect(routes).toHaveLength(4);
  });

  it("gives each NAT gateway its zone's retained address", () => {
    const { template } = buildNetwork();

    template.resourceCountIs("AWS::EC2::NatGateway", 2);
    for (const zone of ["eu-west-2a", "eu-west-2b"]) {
      const id = zone.replaceAll("-", "");
      template.hasResourceProperties("AWS::EC2::NatGateway", {
        AllocationId: {
          "Fn::GetAtt": [
            Match.stringLikeRegexp(`^NatAddresses${id}`),
            "AllocationId",
          ],
        },
        SubnetId: { Ref: Match.stringLikeRegexp(`^NetworkPublic${id}Subnet`) },
      });
    }
    for (const address of Object.values(resources(template, "AWS::EC2::EIP"))) {
      expect(address.DeletionPolicy).toBe("Retain");
    }
  });

  it("alarms on each NAT gateway failing to allocate ports, with no action", () => {
    const { template } = buildNetwork();

    for (const zone of ["eu-west-2a", "eu-west-2b"]) {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: `network-sandbox-nat-${zone}-port-allocation`,
        Namespace: "AWS/NATGateway",
        MetricName: "ErrorPortAllocation",
        Dimensions: [
          {
            Name: "NatGatewayId",
            Value: {
              Ref: Match.stringLikeRegexp(
                `^NetworkPublic${zone.replaceAll("-", "")}NATGateway`,
              ),
            },
          },
        ],
        Statistic: "Sum",
        Period: 60,
        Threshold: 0,
        ComparisonOperator: "GreaterThanThreshold",
        EvaluationPeriods: 15,
        DatapointsToAlarm: 15,
        TreatMissingData: "notBreaching",
        AlarmActions: Match.absent(),
      });
    }
  });

  it("alarms on each NAT gateway dropping more than 0.01% of its packets, with no action", () => {
    const { template } = buildNetwork();

    for (const zone of ["eu-west-2a", "eu-west-2b"]) {
      const natGateway = {
        Name: "NatGatewayId",
        Value: {
          Ref: Match.stringLikeRegexp(
            `^NetworkPublic${zone.replaceAll("-", "")}NATGateway`,
          ),
        },
      };
      const packets = (Id: string, MetricName: string) => ({
        Id,
        MetricStat: {
          Metric: {
            Namespace: "AWS/NATGateway",
            MetricName,
            Dimensions: [natGateway],
          },
          Period: 60,
          Stat: "Sum",
        },
        ReturnData: false,
      });
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: `network-sandbox-nat-${zone}-dropped-packets`,
        Metrics: Match.arrayWith([
          Match.objectLike({
            Expression: "100 * dropped / (fromSource + fromDestination)",
          }),
          packets("dropped", "PacketsDropCount"),
          packets("fromSource", "PacketsInFromSource"),
          packets("fromDestination", "PacketsInFromDestination"),
        ]),
        Threshold: 0.01,
        ComparisonOperator: "GreaterThanThreshold",
        EvaluationPeriods: 5,
        DatapointsToAlarm: 5,
        TreatMissingData: "notBreaching",
        AlarmActions: Match.absent(),
      });
    }
  });

  it("empties the default security group, logging to a log group of the platform's", () => {
    const { template } = buildNetwork();

    template.resourceCountIs("Custom::VpcRestrictDefaultSG", 1);
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/flex/network/sandbox/restrict-default-security-group",
    });
    template.hasResource("AWS::Lambda::Function", {
      Properties: {
        LoggingConfig: {
          LogGroup: {
            Ref: Match.stringLikeRegexp(
              "^NetworkRestrictDefaultSecurityGroupLogs",
            ),
          },
        },
      },
      DependsOn: Match.arrayWith([
        Match.stringLikeRegexp(
          "^NetworkRestrictDefaultSecurityGroupLogsPolicy",
        ),
      ]),
    });
  });

  it("refuses a stack that would look its zones up in the account at synth", () => {
    const stack = new Stack(cdkApp(), "Test", {
      env: { account: "123456789012", region: "eu-west-2" },
    });
    const zones = ["eu-west-2a", "eu-west-2b"];
    const natAddresses = new NatAddresses(stack, "NatAddresses", {
      environment: "sandbox",
      zones,
    });

    expect(
      () =>
        new NetworkVpc(stack, "Network", {
          environment: "sandbox",
          zones,
          natAddresses,
        }),
    ).toThrow("The network's stack must name its availability zones");
  });

  it("is only built in eu-west-2, whose zones it lays out", () => {
    const stack = new Stack(cdkApp(), "Test", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    const zones = ["eu-west-2a", "eu-west-2b"];
    const natAddresses = new NatAddresses(stack, "NatAddresses", {
      environment: "sandbox",
      zones,
    });

    expect(
      () =>
        new NetworkVpc(stack, "Network", {
          environment: "sandbox",
          zones,
          natAddresses,
        }),
    ).toThrow(
      "The network's layout is for eu-west-2's availability zones, not eu-west-1's",
    );
  });
});
