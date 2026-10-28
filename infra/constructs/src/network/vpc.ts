import {
  ArnFormat,
  CfnResource,
  Duration,
  Stack,
  Tags,
  Validations,
} from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  MathExpression,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import {
  CfnInternetGateway,
  CfnVPCGatewayAttachment,
  IpAddresses,
  type IVpc,
  PrivateSubnet,
  PublicSubnet,
  type Subnet,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import {
  CfnPolicy,
  PolicyDocument,
  PolicyStatement,
} from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

import { PlatformLogGroup } from "../log-group.ts";
import { NETWORK_REGION, subnetCidr, VPC_CIDR } from "./layout.ts";
import {
  natGatewayAlarmName,
  restrictDefaultSecurityGroupLogGroupName,
  subnetName,
  type Tier,
  vpcName,
} from "./names.ts";
import type { NatAddresses } from "./nat-addresses.ts";

// Where CDK puts the function that empties a VPC's default security group: one per stack.
const RESTRICT_DEFAULT_SG_PROVIDER =
  "Custom::VpcRestrictDefaultSGCustomResourceProvider";

export interface NetworkVpcProps {
  readonly environment: string;
  /** Sorted, as `networkZones` returns them. */
  readonly zones: readonly string[];
  /** Each zone's NAT gateway takes its address from here. */
  readonly natAddresses: NatAddresses;
}

/**
 * The VPC, and a public, a private and an isolated subnet in each availability zone. Subnets are
 * built by zone name, each with the range `ZONE_LAYOUT` gives it, so a zone's subnets keep their
 * construct IDs and ranges whatever other zones config lists.
 *
 * - isolated: only the local route. Reaches AWS through the interface endpoints.
 * - private: a default route to its zone's NAT gateway. AWS Network Firewall is planned between
 *   them, replacing that route.
 * - public: a default route to the internet gateway, and the zone's NAT gateway. Nothing else.
 */
export class NetworkVpc extends Construct {
  public readonly vpc: IVpc;
  /** Each tier's subnets, one per zone, in zone order. */
  public readonly subnets: Readonly<Record<Tier, readonly Subnet[]>>;
  /**
   * Each NAT gateway's alarms, with no actions: the stack adds them. A NAT gateway that can't
   * open a connection, or drops packets, fails the private gateways' calls in its zone.
   */
  public readonly natGatewayAlarms: readonly Alarm[];

  constructor(scope: Construct, id: string, props: NetworkVpcProps) {
    super(scope, id);

    const { environment, zones, natAddresses } = props;
    const stack = Stack.of(this);
    if (stack.region !== NETWORK_REGION) {
      throw new Error(
        `The network's layout is for ${NETWORK_REGION}'s availability zones, not ${stack.region}'s`,
      );
    }

    // CDK's Vpc checks its zones against the stack's, and a stack that doesn't name its own looks
    // them up in the account at synth, answering with placeholders until it has. Checked here
    // first, so a stack that doesn't name them fails with a reason rather than a lookup.
    const stackZones = stack.availabilityZones;
    if (!zones.every((zone) => stackZones.includes(zone))) {
      throw new Error(
        `The network's stack must name its availability zones, ${zones.join(", ")}, by overriding availabilityZones, so synth looks nothing up`,
      );
    }

    // No subnets from CDK's own allocation: it numbers them by position, so a change to the zones
    // would renumber, and replace, the rest.
    const vpc = new Vpc(this, "Vpc", {
      vpcName: vpcName(environment),
      ipAddresses: IpAddresses.cidr(VPC_CIDR),
      availabilityZones: [...zones],
      subnetConfiguration: [],
      natGateways: 0,
      restrictDefaultSecurityGroup: true,
    });
    // CDK declares Vpc's `vpnGatewayId` as possibly undefined and IVpc's as optional, which
    // `exactOptionalPropertyTypes` won't match.
    this.vpc = vpc as IVpc;

    const internetGateway = new CfnInternetGateway(this, "InternetGateway");
    Tags.of(internetGateway).add("Name", vpcName(environment));
    const attachment = new CfnVPCGatewayAttachment(
      this,
      "InternetGatewayAttachment",
      { vpcId: this.vpc.vpcId, internetGatewayId: internetGateway.ref },
    );

    // CloudFormation's own validation warns on a zone named outright. Here each subnet's zone, and
    // with it its range, is fixed by ZONE_LAYOUT, so adding or removing a zone moves no other.
    Validations.of(this).acknowledge({
      id: "CloudFormation-Validate::W3010",
      reason:
        "Each subnet's zone, and with it its range, is fixed by ZONE_LAYOUT. Config lists the zones, and the stack names them.",
    });

    const natGatewayAlarms: Alarm[] = [];
    const subnets: Record<Tier, Subnet[]> = {
      public: [],
      private: [],
      isolated: [],
    };
    for (const zone of zones) {
      const subnetProps = (tier: Tier) => ({
        vpcId: this.vpc.vpcId,
        availabilityZone: zone,
        cidrBlock: subnetCidr(zone, tier),
      });

      const publicSubnet = new PublicSubnet(this, `Public-${zone}`, {
        ...subnetProps("public"),
        mapPublicIpOnLaunch: false,
      });
      publicSubnet.addDefaultInternetRoute(internetGateway.ref, attachment);
      const natGateway = publicSubnet.addNatGateway(
        natAddresses.address(zone).allocationId,
      );
      natGatewayAlarms.push(
        ...this.alarmOnNatGateway(environment, zone, natGateway.ref),
      );

      const privateSubnet = new PrivateSubnet(
        this,
        `Private-${zone}`,
        subnetProps("private"),
      );
      privateSubnet.addDefaultNatRoute(natGateway.ref);

      const isolatedSubnet = new PrivateSubnet(
        this,
        `Isolated-${zone}`,
        subnetProps("isolated"),
      );

      for (const [tier, subnet] of [
        ["public", publicSubnet],
        ["private", privateSubnet],
        ["isolated", isolatedSubnet],
      ] as const) {
        Tags.of(subnet).add("Name", subnetName(environment, tier, zone));
        subnets[tier].push(subnet);
      }
    }
    this.subnets = subnets;
    this.natGatewayAlarms = natGatewayAlarms;

    this.logDefaultSecurityGroupRestriction(stack, environment);
  }

  // As CloudWatch's recommended alarms for a NAT gateway set them. NAT gateways publish nothing for
  // a minute with no traffic.
  private alarmOnNatGateway(
    environment: string,
    zone: string,
    natGatewayId: string,
  ): Alarm[] {
    const metric = (metricName: string) =>
      new Metric({
        namespace: "AWS/NATGateway",
        metricName,
        dimensionsMap: { NatGatewayId: natGatewayId },
        statistic: "Sum",
        period: Duration.minutes(1),
      });
    const id = zone.replaceAll("-", "");

    return [
      new Alarm(this, `NatPortAllocation${id}`, {
        alarmName: natGatewayAlarmName(environment, zone, "port-allocation"),
        alarmDescription: `The NAT gateway in ${environment}'s ${zone} couldn't give a new connection a source port, every minute for 15 minutes: too many connections are open to one destination.`,
        metric: metric("ErrorPortAllocation"),
        threshold: 0,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 15,
        datapointsToAlarm: 15,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
      new Alarm(this, `NatDroppedPackets${id}`, {
        alarmName: natGatewayAlarmName(environment, zone, "dropped-packets"),
        alarmDescription: `The NAT gateway in ${environment}'s ${zone} dropped more than 0.01% of its packets, every minute for 5 minutes. Check AWS Health for NAT gateways in the region.`,
        metric: new MathExpression({
          expression: "100 * dropped / (fromSource + fromDestination)",
          usingMetrics: {
            dropped: metric("PacketsDropCount"),
            fromSource: metric("PacketsInFromSource"),
            fromDestination: metric("PacketsInFromDestination"),
          },
          label: "Dropped packets (%)",
          period: Duration.minutes(1),
        }),
        threshold: 0.01,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    ];
  }

  // CDK empties the default security group, which allows all traffic out and in from itself,
  // with a function of its own. Lambda would create that function's log group when it first
  // writes, unencrypted, kept forever and outside every check, so the function is pointed at one
  // of ours. `findChild` throws if a CDK upgrade moves it, so synth fails rather than the
  // function logging somewhere else unseen.
  private logDefaultSecurityGroupRestriction(
    stack: Stack,
    environment: string,
  ): void {
    const provider = stack.node.findChild(RESTRICT_DEFAULT_SG_PROVIDER);
    const handler = provider.node.findChild("Handler");
    const role = provider.node.findChild("Role");
    if (!(handler instanceof CfnResource) || !(role instanceof CfnResource)) {
      throw new TypeError(
        `${RESTRICT_DEFAULT_SG_PROVIDER} no longer has the Handler and Role this construct configures`,
      );
    }

    const logGroupName = restrictDefaultSecurityGroupLogGroupName(environment);
    const { logGroup, key } = new PlatformLogGroup(
      this,
      "RestrictDefaultSecurityGroupLogs",
      { logGroupName },
    );
    handler.addPropertyOverride("LoggingConfig", {
      LogGroup: logGroup.logGroupName,
    });

    const logGroupArn = stack.formatArn({
      service: "logs",
      resource: "log-group",
      resourceName: logGroupName,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    // A log group encrypted with a customer managed key takes the key to write to, through
    // CloudWatch Logs, for this log group alone.
    const policy = new CfnPolicy(
      this,
      "RestrictDefaultSecurityGroupLogsPolicy",
      {
        policyName: "WriteLogs",
        roles: [role.ref],
        policyDocument: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [`${logGroupArn}:*`],
            }),
            new PolicyStatement({
              actions: ["kms:Encrypt", "kms:GenerateDataKey*"],
              resources: [key.keyArn],
              conditions: {
                StringEquals: {
                  "kms:ViaService": `logs.${stack.region}.amazonaws.com`,
                },
                ArnEquals: {
                  "kms:EncryptionContext:aws:logs:arn": logGroupArn,
                },
              },
            }),
          ],
        }),
      },
    );
    handler.node.addDependency(policy);

    Validations.of(policy).acknowledge(
      {
        id: `AwsSolutions-IAM5[Resource::${logGroupArn}:*]`,
        reason:
          "Lambda names each log stream itself, so the grant covers every stream in the one log group.",
      },
      {
        id: "AwsSolutions-IAM5[Action::kms:GenerateDataKey*]",
        reason:
          "CloudWatch Logs chooses which GenerateDataKey call it makes; the grant holds only for the one key and log group.",
      },
    );
  }
}
