import { gatewayFunctionPattern } from "@repo/gateway-infra";
import {
  DnsFirewall,
  FlowLogs,
  InterfaceEndpoints,
  NatAddresses,
  NETWORK_REGION,
  NetworkAcls,
  NetworkParameters,
  NetworkVpc,
  networkZones,
  type Placement,
  WorkloadSecurityGroup,
} from "@repo/infra-constructs";
import { CfnOutput, Stack } from "aws-cdk-lib";
import type { InterfaceVpcEndpoint, ISecurityGroup } from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";

import type {
  DomainAccountConfig,
  EnvironmentConfig,
} from "../config/types.ts";

export function networkStackName(
  environment: EnvironmentConfig,
  domainAccount: DomainAccountConfig,
): string {
  return `network-${environment.name}-${domainAccount.name}`;
}

interface Workload {
  readonly id: string;
  readonly workload: string;
  readonly placement: Placement;
  /** The endpoints it may reach. */
  readonly reaches: (endpoints: InterfaceEndpoints) => InterfaceVpcEndpoint[];
}

// What runs in the network, and the endpoints each may reach: a domain's to invoke gateways, a
// gateway's to read its secret and assume an upstream's role.
const WORKLOADS: readonly Workload[] = [
  {
    id: "DomainWorkload",
    workload: "domain",
    placement: "isolated",
    reaches: ({ lambda }) => [lambda],
  },
  {
    id: "IsolatedGatewayWorkload",
    workload: "isolated-gateway",
    placement: "isolated",
    reaches: ({ secretsManager, sts }) => [secretsManager, sts],
  },
  {
    id: "PrivateGatewayWorkload",
    workload: "private-gateway",
    placement: "private",
    reaches: ({ secretsManager, sts }) => [secretsManager, sts],
  },
];

interface NetworkStackProps {
  readonly environment: EnvironmentConfig;
  readonly domainAccount: DomainAccountConfig;
}

/**
 * A domain account's network, which its domains and gateways run in. Other stacks and the release
 * pipeline find its IDs in SSM, under names derived from config.
 */
export class NetworkStack extends Stack {
  readonly #zones: readonly string[];

  constructor(
    scope: Construct,
    { environment, domainAccount }: NetworkStackProps,
  ) {
    super(scope, networkStackName(environment, domainAccount), {
      description: `Flex network for the ${domainAccount.name} domain account in the ${environment.name} environment`,
      env: { account: domainAccount.account, region: NETWORK_REGION },
      // Deleting it would take every domain's and gateway's network with it, and the NAT
      // addresses upstreams allowlist.
      terminationProtection: true,
    });

    const zones = networkZones(domainAccount.network.availabilityZones);
    this.#zones = zones;
    const natAddresses = new NatAddresses(this, "NatAddresses", {
      environment: environment.name,
      zones,
    });
    const { vpc, subnets } = new NetworkVpc(this, "Network", {
      environment: environment.name,
      zones,
      natAddresses,
    });
    new NetworkAcls(this, "NetworkAcls", { vpc, subnets });
    new FlowLogs(this, "FlowLogs", { environment: environment.name, vpc });

    const endpoints = new InterfaceEndpoints(this, "Endpoints", {
      vpc,
      subnets: subnets.isolated,
      // Any domain may invoke any of its environment's gateways.
      invokableFunctions: gatewayFunctionPattern(environment.name),
    });
    // The names the SDK calls the endpoints at, and every name the account's gateways resolve.
    const { gateways } = domainAccount;
    new DnsFirewall(this, "DnsFirewall", {
      environment: environment.name,
      vpc,
      hostnames: [
        ...endpoints.hostnames,
        ...gateways.flatMap(({ hostnames }) => hostnames),
      ],
    });

    const securityGroups: Record<string, ISecurityGroup> = {};
    for (const { id, workload, placement, reaches } of WORKLOADS) {
      const { securityGroup } = new WorkloadSecurityGroup(this, id, {
        vpc,
        workload,
        placement,
        endpoints: reaches(endpoints),
      });
      securityGroups[workload] = securityGroup;
    }

    new NetworkParameters(this, "Parameters", {
      environment: environment.name,
      vpc,
      subnets: { isolated: subnets.isolated, private: subnets.private },
      securityGroups,
    });

    // The one value nothing can derive, and the one upstreams need: the address a private
    // gateway's requests come from.
    for (const zone of zones) {
      new CfnOutput(this, `NatAddress-${zone}`, {
        description: `The address requests leave ${zone} from`,
        value: natAddresses.address(zone).publicIp,
      });
    }
  }

  // The zones config names. Otherwise CDK would look the account's up at synth.
  override get availabilityZones(): string[] {
    return [...this.#zones];
  }
}
