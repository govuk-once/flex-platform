import { gatewayAliasPattern, gatewayRolePattern } from "@repo/gateway-infra";
import {
  accountOf,
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
  type PrivateApiAccess,
  WorkloadSecurityGroup,
} from "@repo/infra-constructs";
import { sortedNames } from "@repo/utils/sorted-names";
import { CfnOutput, Stack } from "aws-cdk-lib";
import type { InterfaceVpcEndpoint, ISecurityGroup } from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";

import type {
  DomainAccountConfig,
  EnvironmentConfig,
} from "../config/types.ts";
import { callerTokenPublicKeysTableArn } from "./frontdoor-keys.ts";
import { endpointSecretArn } from "./gateway.ts";

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
// gateway's to read its secret, assume an upstream's role and read the caller token's public keys.
// An isolated gateway has no other way out, so it reaches an upstream's private API through
// `execute-api` too.
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
    reaches: ({ secretsManager, sts, dynamoDb, executeApi }) => [
      secretsManager,
      sts,
      dynamoDb,
      executeApi,
    ],
  },
  {
    id: "PrivateGatewayWorkload",
    workload: "private-gateway",
    placement: "private",
    reaches: ({ secretsManager, sts, dynamoDb }) => [
      secretsManager,
      sts,
      dynamoDb,
    ],
  },
];

// Every private API the account's gateways call, as a principal of the account of a role one of
// them signs as. Which role a gateway signs as is held by its own role, which may assume only those
// it names in roleArns.
function privateApiAccess(
  gateways: DomainAccountConfig["gateways"],
): PrivateApiAccess {
  const calling = gateways.filter(
    ({ privateApiArns }) => privateApiArns.length > 0,
  );
  return {
    apiArns: sortedNames(new Set(calling.flatMap((g) => g.privateApiArns))),
    callerAccounts: sortedNames(
      new Set(calling.flatMap((g) => g.roleArns.map(accountOf))),
    ),
  };
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

    const endpoints = new InterfaceEndpoints(this, "Endpoints", {
      vpc,
      subnets: subnets.isolated,
      // Any domain may invoke any of its environment's gateways, by the alias its client names.
      invokableFunctions: gatewayAliasPattern(environment.name),
      // In the frontdoor account, where key rotation keeps them.
      readableTables: [callerTokenPublicKeysTableArn(environment)],
      readableSecrets: sortedNames(
        new Set(
          domainAccount.gateways.map((gateway) =>
            endpointSecretArn(environment, domainAccount, gateway),
          ),
        ),
      ),
      assumableRoles: sortedNames(
        new Set(domainAccount.gateways.flatMap(({ roleArns }) => roleArns)),
      ),
      gatewayRoles: gatewayRolePattern(environment.name),
      invokableApis: privateApiAccess(domainAccount.gateways),
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
      endpointAddresses: [endpoints.dynamoDbAddress],
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
      endpoints: endpoints.byService,
      endpointAddresses: { dynamodb: endpoints.dynamoDbAddress },
    });

    // The values nothing can derive, and the ones upstreams need: the address a private
    // gateway's requests come from, and the endpoint an isolated gateway's calls to a private API
    // come through, which that API's policy names.
    for (const zone of zones) {
      new CfnOutput(this, `NatAddress-${zone}`, {
        description: `The address requests leave ${zone} from`,
        value: natAddresses.address(zone).publicIp,
      });
    }
    new CfnOutput(this, "ExecuteApiEndpointId", {
      description:
        "The endpoint calls to an upstream's private API come through",
      value: endpoints.executeApi.vpcEndpointId,
    });
  }

  // The zones config names. Otherwise CDK would look the account's up at synth.
  override get availabilityZones(): string[] {
    return [...this.#zones];
  }
}
