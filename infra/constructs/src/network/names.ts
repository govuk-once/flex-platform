// Names derived from config, so nothing reads one back from a deployed stack. The network is one
// per domain account, and each account has its own, so a name needs no account in it:
//
//   network-{environment}                     the VPC
//   network-{environment}-{tier}-{zone}       a subnet
//   network-{environment}-nat-{zone}-{thing}  a NAT gateway's alarms
//   /flex/network/{environment}/...           log groups, and the parameters other stacks and the
//                                             release pipeline read IDs from

/** A subnet tier. `public` holds only the NAT gateways. */
export type Tier = "public" | "private" | "isolated";

/** The tiers a workload runs in. */
export type Placement = Exclude<Tier, "public">;

export function vpcName(environment: string): string {
  return `network-${environment}`;
}

export function subnetName(
  environment: string,
  tier: Tier,
  zone: string,
): string {
  return `${vpcName(environment)}-${tier}-${zone}`;
}

export function vpcIdParameterName(environment: string): string {
  return `/flex/network/${environment}/vpc-id`;
}

/** A list of the placement's subnet IDs, one per availability zone. */
export function subnetIdsParameterName(
  environment: string,
  placement: Placement,
): string {
  return `/flex/network/${environment}/${placement}-subnet-ids`;
}

/** A workload's security group, such as `domain`. */
export function securityGroupIdParameterName(
  environment: string,
  workload: string,
): string {
  return `/flex/network/${environment}/security-group/${workload}`;
}

/** Where CDK's function that empties the VPC's default security group logs. */
export function restrictDefaultSecurityGroupLogGroupName(
  environment: string,
): string {
  return `/flex/network/${environment}/restrict-default-security-group`;
}

/** An alarm on one zone's NAT gateway. */
export function natGatewayAlarmName(
  environment: string,
  zone: string,
  thing: string,
): string {
  return `${vpcName(environment)}-nat-${zone}-${thing}`;
}

/** The VPC's rejected flows, which are forwarded to the central logs. */
export function rejectedFlowLogGroupName(environment: string): string {
  return `/flex/network/${environment}/rejected-flows`;
}
