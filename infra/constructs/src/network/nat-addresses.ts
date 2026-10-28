import { RemovalPolicy, Tags } from "aws-cdk-lib";
import { CfnEIP } from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

import { vpcName } from "./names.ts";

export interface NatAddressesProps {
  readonly environment: string;
  /** Sorted, as `networkZones` returns them. */
  readonly zones: readonly string[];
}

/**
 * One elastic IP per availability zone, for its NAT gateway. Upstreams allowlist these addresses,
 * so they sit under a construct of their own, which the VPC's construct path can't move, and are
 * retained: losing one means every upstream allowlisting it has to change.
 */
export class NatAddresses extends Construct {
  readonly #addresses = new Map<string, CfnEIP>();

  constructor(scope: Construct, id: string, props: NatAddressesProps) {
    super(scope, id);

    for (const zone of props.zones) {
      const address = new CfnEIP(this, zone, { domain: "vpc" });
      address.applyRemovalPolicy(RemovalPolicy.RETAIN);
      Tags.of(address).add("Name", `${vpcName(props.environment)}-nat-${zone}`);
      this.#addresses.set(zone, address);
    }
  }

  /** The zone's address, as an allocation ID and as the IP upstreams see. */
  address(zone: string): { allocationId: string; publicIp: string } {
    const address = this.#addresses.get(zone);
    if (address === undefined) {
      throw new Error(`No NAT address for the availability zone ${zone}`);
    }
    return {
      allocationId: address.attrAllocationId,
      publicIp: address.attrPublicIp,
    };
  }
}
