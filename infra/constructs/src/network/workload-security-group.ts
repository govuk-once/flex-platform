import {
  CfnSecurityGroupEgress,
  CfnSecurityGroupIngress,
  type InterfaceVpcEndpoint,
  type IVpc,
  Peer,
  Port,
  SecurityGroup,
} from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

import type { Placement } from "./names.ts";

const HTTPS = { ipProtocol: "tcp", fromPort: 443, toPort: 443 };

export interface WorkloadSecurityGroupProps {
  readonly vpc: IVpc;
  /** What runs in it, such as `domain`. */
  readonly workload: string;
  readonly placement: Placement;
  /** The endpoints it may reach. Each one's own group lets it in. */
  readonly endpoints: readonly InterfaceVpcEndpoint[];
}

/**
 * The security group one kind of workload runs in: nothing in, and out only on TCP port 443, to the
 * endpoints named and, in the private tier, through its zone's NAT gateway. The port doesn't make
 * the traffic TLS.
 */
export class WorkloadSecurityGroup extends Construct {
  public readonly securityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, props: WorkloadSecurityGroupProps) {
    super(scope, id);

    const { vpc, workload, placement, endpoints } = props;

    this.securityGroup = new SecurityGroup(this, "SecurityGroup", {
      vpc,
      description: `${workload} workloads, ${placement} tier`,
      allowAllOutbound: false,
    });
    if (placement === "private") {
      this.securityGroup.addEgressRule(
        Peer.anyIpv4(),
        Port.tcp(443),
        "TCP 443 out through NAT",
      );
    }

    // Written here rather than with `connections`, which would name each rule after the other
    // group's construct path, stack name and so environment included, and would drop the rule
    // CDK uses to keep EC2's default allow-all egress off a group with no other inline rule.
    for (const endpoint of endpoints) {
      const name = endpoint.node.id;
      const [endpointGroup, ...others] = endpoint.connections.securityGroups;
      if (endpointGroup === undefined || others.length > 0) {
        throw new Error(
          `The ${name} endpoint must have one security group of its own`,
        );
      }
      new CfnSecurityGroupEgress(this, `To${name}`, {
        groupId: this.securityGroup.securityGroupId,
        destinationSecurityGroupId: endpointGroup.securityGroupId,
        description: `HTTPS to the ${name} endpoint`,
        ...HTTPS,
      });
      new CfnSecurityGroupIngress(this, `Into${name}`, {
        groupId: endpointGroup.securityGroupId,
        sourceSecurityGroupId: this.securityGroup.securityGroupId,
        description: `HTTPS from ${workload} workloads`,
        ...HTTPS,
      });
    }
  }
}
