import { Annotations, Arn, ArnFormat } from "aws-cdk-lib";
import type { ISecurityGroup, ISubnet, IVpc } from "aws-cdk-lib/aws-ec2";
import { SecurityGroup, Subnet, Vpc } from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";

import type { AccessLevel } from "./config.ts";

// Subnets and their security group, created by the network stack.
export interface NetworkPlacement {
  readonly subnetArns: readonly string[];
  readonly securityGroupArn: string;
}

// Every domain is given the whole network, whatever its access level. What each placement can
// reach is the network stack's to enforce. CDK needs the zones to import a VPC.
export interface DomainNetwork {
  readonly vpcArn: string;
  readonly availabilityZones: readonly string[];
  readonly isolated: NetworkPlacement;
  readonly private: NetworkPlacement;
}

export interface FunctionVpcSettings {
  readonly vpc: IVpc;
  readonly vpcSubnets: { readonly subnets: ISubnet[] };
  readonly securityGroups: ISecurityGroup[];
}

export interface VpcSettingsOptions {
  readonly access: AccessLevel;
}

// None for "public". Imports only the placement in use. An empty placement would otherwise fail
// only at deploy.
export function vpcSettingsFor(
  scope: Construct,
  network: DomainNetwork,
  { access }: VpcSettingsOptions,
): FunctionVpcSettings | undefined {
  if (access === "public") return;

  const { subnetArns, securityGroupArn } = network[access];

  if (subnetArns.length === 0) {
    throw new Error(
      `The network has no ${access} subnets to place a domain's function in`,
    );
  }

  return {
    vpc: importVpc(scope, network),
    vpcSubnets: { subnets: subnetArns.map((arn) => importSubnet(scope, arn)) },
    securityGroups: [importSecurityGroup(scope, securityGroupArn)],
  };
}

// Lambda takes only subnets, but CDK requires their VPC.
function importVpc(
  scope: Construct,
  { vpcArn, availabilityZones }: DomainNetwork,
): IVpc {
  if (availabilityZones.length === 0) {
    throw new Error("The network names no availability zones");
  }

  return Vpc.fromVpcAttributes(scope, "Vpc", {
    vpcId: ec2IdFrom(vpcArn, { resource: "vpc" }),
    availabilityZones: [...availabilityZones],
  });
}

function importSubnet(scope: Construct, subnetArn: string): ISubnet {
  const subnetId = ec2IdFrom(subnetArn, { resource: "subnet" });

  const subnet = Subnet.fromSubnetId(scope, subnetId, subnetId);

  Annotations.of(subnet).acknowledgeWarning(
    "@aws-cdk/aws-ec2:noSubnetRouteTableId",
    "Lambda takes only the subnet's ID. Nothing reads its route table.",
  );

  return subnet;
}

function importSecurityGroup(
  scope: Construct,
  securityGroupArn: string,
): ISecurityGroup {
  const securityGroupId = ec2IdFrom(securityGroupArn, {
    resource: "security-group",
  });

  return SecurityGroup.fromSecurityGroupId(
    scope,
    securityGroupId,
    securityGroupId,
    { mutable: false, allowAllOutbound: false },
  );
}

interface Ec2IdOptions {
  readonly resource: "security-group" | "subnet" | "vpc";
}

// Refuses an ARN for another kind of resource, such as a security group's given as a subnet's.
function ec2IdFrom(arn: string, { resource }: Ec2IdOptions): string {
  const {
    service,
    resource: actual,
    resourceName,
  } = Arn.split(arn, ArnFormat.SLASH_RESOURCE_NAME);

  if (service !== "ec2" || actual !== resource || !resourceName) {
    throw new Error(
      `${JSON.stringify(arn)} is not the ARN of an EC2 ${resource}`,
    );
  }

  return resourceName;
}
