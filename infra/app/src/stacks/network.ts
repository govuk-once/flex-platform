import {
  FlowLogs,
  NatAddresses,
  NETWORK_REGION,
  NetworkAcls,
  NetworkParameters,
  NetworkVpc,
  networkZones,
} from "@repo/infra-constructs";
import { CfnOutput, Stack } from "aws-cdk-lib";
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

    new NetworkParameters(this, "Parameters", {
      environment: environment.name,
      vpc,
      subnets: { isolated: subnets.isolated, private: subnets.private },
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
