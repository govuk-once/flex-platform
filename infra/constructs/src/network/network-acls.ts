import { Validations } from "aws-cdk-lib";
import {
  AclCidr,
  AclTraffic,
  Action,
  type ISubnet,
  type IVpc,
  NetworkAcl,
  SubnetNetworkAclAssociation,
  TrafficDirection,
} from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

import { VPC_CIDR } from "./layout.ts";
import type { Tier } from "./names.ts";

interface Entry {
  readonly rule: number;
  readonly direction: TrafficDirection;
  /** The VPC itself, or anywhere. */
  readonly peer: "vpc" | "anywhere";
  readonly traffic: AclTraffic;
  readonly action: Action;
}

const { INGRESS, EGRESS } = TrafficDirection;
const { ALLOW, DENY } = Action;

// Anything within the VPC, both ways: the endpoints, the NAT gateways and DNS.
const WITHIN_VPC: readonly Entry[] = [
  {
    rule: 100,
    direction: INGRESS,
    peer: "vpc",
    traffic: AclTraffic.allTraffic(),
    action: ALLOW,
  },
  {
    rule: 100,
    direction: EGRESS,
    peer: "vpc",
    traffic: AclTraffic.allTraffic(),
    action: ALLOW,
  },
];

// Refused from outside the VPC, after the VPC's own traffic is let in and before anything else is.
// The ACL's last rule already refuses ports below 1024, which nothing here allows, so these only
// say so.
const REFUSED_IN: readonly Entry[] = [
  {
    rule: 110,
    direction: INGRESS,
    peer: "anywhere",
    traffic: AclTraffic.tcpPortRange(0, 1023),
    action: DENY,
  },
  {
    rule: 111,
    direction: INGRESS,
    peer: "anywhere",
    traffic: AclTraffic.udpPortRange(0, 1023),
    action: DENY,
  },
];

// TCP 443 out to anywhere, and its replies back in. A network ACL keeps no state, so a reply is
// let in by its port alone, and a NAT gateway or Lambda may take any port from 1024 up for one.
const HTTPS_OUT: readonly Entry[] = [
  {
    rule: 200,
    direction: EGRESS,
    peer: "anywhere",
    traffic: AclTraffic.tcpPort(443),
    action: ALLOW,
  },
  {
    rule: 200,
    direction: INGRESS,
    peer: "anywhere",
    traffic: AclTraffic.tcpPortRange(1024, 65535),
    action: ALLOW,
  },
];

/**
 * Each tier's entries, in rule order; a network ACL denies whatever none of them matches. Security
 * groups are the control a workload is held to. These hold a tier to its purpose whatever a
 * security group allows: an isolated subnet reaches nothing outside the VPC even if a route out
 * were added. The private tier reaches the internet only on 443, and the public tier only passes
 * that on.
 */
export const NETWORK_ACL_ENTRIES: Readonly<Record<Tier, readonly Entry[]>> = {
  isolated: [...WITHIN_VPC, ...REFUSED_IN],
  private: [...WITHIN_VPC, ...REFUSED_IN, ...HTTPS_OUT],
  public: [...WITHIN_VPC, ...REFUSED_IN, ...HTTPS_OUT],
};

export interface NetworkAclsProps {
  readonly vpc: IVpc;
  readonly subnets: Readonly<Record<Tier, readonly ISubnet[]>>;
}

/** One network ACL per tier, with `NETWORK_ACL_ENTRIES`. */
export class NetworkAcls extends Construct {
  constructor(scope: Construct, id: string, props: NetworkAclsProps) {
    super(scope, id);

    Validations.of(this).acknowledge({
      id: "AwsSolutions-VPC3",
      reason:
        "The rule only reports that network ACLs are in use. These are a second layer under the security groups, holding each tier to its purpose.",
    });

    for (const tier of ["public", "private", "isolated"] as const) {
      const acl = new NetworkAcl(this, tier, { vpc: props.vpc });
      // By zone, not with `subnetSelection`, which names each association after the subnet's
      // construct path, stack name and so environment included.
      for (const subnet of props.subnets[tier]) {
        new SubnetNetworkAclAssociation(
          this,
          `${tier}-${subnet.availabilityZone}`,
          { networkAcl: acl, subnet },
        );
      }
      for (const {
        rule,
        direction,
        peer,
        traffic,
        action,
      } of NETWORK_ACL_ENTRIES[tier]) {
        acl.addEntry(`${direction === INGRESS ? "In" : "Out"}${rule}`, {
          ruleNumber: rule,
          direction,
          cidr: peer === "vpc" ? AclCidr.ipv4(VPC_CIDR) : AclCidr.anyIpv4(),
          traffic,
          ruleAction: action,
        });
      }
    }
  }
}
