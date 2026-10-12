import type { CfnFunction } from "aws-cdk-lib/aws-lambda";

import type { DomainConfig } from "./config.ts";
import { accessOf } from "./config.ts";

// Subnets and the security group that goes with them, by ID. Lambda takes only these: it finds
// the VPC from the subnets, and the zones from the subnets too.
export interface NetworkPlacement {
  readonly subnetIds: readonly string[];
  readonly securityGroupId: string;
}

// The placements a domain account's network offers, each named for the access level that selects
// it. One the network doesn't have is left out, and a domain that asks for it stops synth. What
// each placement can reach is the network's to enforce.
export interface DomainNetwork {
  readonly isolated?: NetworkPlacement;
  readonly private?: NetworkPlacement;
}

export interface NetworkCheckOptions {
  /** Where the network is, at the start of each message. */
  readonly at: string;
}

type PlacementLevel = keyof DomainNetwork;

// EC2's IDs: a prefix for the kind of resource, then 8 or 17 hex digits.
const SUBNET_ID = /^subnet-[0-9a-f]{8}(?:[0-9a-f]{9})?$/;
const SECURITY_GROUP_ID = /^sg-[0-9a-f]{8}(?:[0-9a-f]{9})?$/;

const PLACEMENT_LEVELS: readonly PlacementLevel[] = ["isolated", "private"];

// Throws on the first problem. A malformed ID, or a subnet in two placements, would otherwise fail
// only at deploy, or not at all.
export function validateNetwork(
  network: DomainNetwork,
  { at }: NetworkCheckOptions,
): void {
  const placementOfSubnet = new Map<string, PlacementLevel>();

  for (const level of PLACEMENT_LEVELS) {
    const placement = network[level];

    if (placement === undefined) continue;

    const { subnetIds, securityGroupId } = placement;

    if (subnetIds.length === 0) {
      throw new Error(`${at}: the ${level} placement has no subnets`);
    }

    for (const subnetId of subnetIds) {
      if (!SUBNET_ID.test(subnetId)) {
        throw new Error(
          `${at}: ${JSON.stringify(subnetId)} is not a subnet ID, such as subnet-0123456789abcdef0`,
        );
      }

      const existing = placementOfSubnet.get(subnetId);

      if (existing !== undefined) {
        throw new Error(
          `${at}: ${subnetId} is in the ${existing} placement already, so the ${level} placement can't have it`,
        );
      }

      placementOfSubnet.set(subnetId, level);
    }

    if (!SECURITY_GROUP_ID.test(securityGroupId)) {
      throw new Error(
        `${at}: ${JSON.stringify(securityGroupId)} is not a security group ID, such as sg-0123456789abcdef0`,
      );
    }
  }
}

// None for "public". Refuses a level the network doesn't offer.
export function placementFor(
  config: DomainConfig,
  network: DomainNetwork,
): NetworkPlacement | undefined {
  const access = accessOf(config);

  if (access === "public") return;

  const placement = network[access];

  if (placement === undefined) {
    throw new Error(
      `The ${config.name} domain is ${access}, and its domain account's network has no ${access} placement`,
    );
  }

  return placement;
}

// Set on the function's CloudFormation resource: CDK's Function takes subnets only with an
// imported VPC, which would need the VPC's ID and zones, neither of which Lambda reads.
export function vpcConfigFor({
  subnetIds,
  securityGroupId,
}: NetworkPlacement): CfnFunction.VpcConfigProperty {
  return {
    subnetIds: [...subnetIds],
    securityGroupIds: [securityGroupId],
  };
}
