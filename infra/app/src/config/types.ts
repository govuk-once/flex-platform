import type { TrustedIssuer } from "@repo/frontdoor-shared";

// Everything that differs between stages and environments is a value here. Constructs receive
// these values, never a stage or environment name to branch on.

// Names are used in resource names and DNS labels, so each is a lowercase DNS label.

/**
 * A delegated public hosted zone the platform team created in one of our accounts. An account
 * writes records only into its own zone. It isn't ours to create, so config names it.
 */
export interface ZoneConfig {
  /** Such as `production.flex-domain00.once.service.gov.uk`, with no trailing dot. */
  readonly name: string;
  /** Such as `Z0411378AOM55J0BQQZI`, without `/hostedzone/`. */
  readonly id: string;
}

/** The domain account's network, which its domains and gateways run in. */
export interface NetworkConfig {
  /**
   * Such as `["eu-west-2a", "eu-west-2b"]`, in any order. Each has its own NAT gateway, and each
   * keeps its subnets' ranges whatever else is listed.
   */
  readonly availabilityZones: readonly string[];
}

/**
 * A gateway deployed in a domain account, with the names it connects to in that environment. They
 * join the account's DNS allowlist, which is VPC-wide: every workload in the network may resolve
 * every name on it.
 */
export interface GatewayConfig {
  /** As in its package's name, `@repo/gateway-service-<id>`. */
  readonly id: string;
  /**
   * Exact hostnames it connects to: its upstream's API, and any host it takes a token from. Never
   * a name read from a secret or a request, unless it is also here.
   */
  readonly hostnames: readonly string[];
}

export interface DomainAccountConfig {
  readonly name: string;
  readonly account: string;
  /** The domains the account hosts in this environment. */
  readonly domains: readonly string[];
  /** Each domain answers at `<domain>.<zone>`, under one wildcard certificate. */
  readonly zone: ZoneConfig;
  readonly network: NetworkConfig;
  /** The gateways deployed in the account, in this environment. */
  readonly gateways: readonly GatewayConfig[];
}

export interface SharedConfig {
  readonly account: string;
}

export interface FrontdoorConfig {
  readonly account: string;
  /** The edge answers at this zone's apex. */
  readonly zone: ZoneConfig;
  /** The user pools and app clients whose tokens the edge lets through. */
  readonly issuers: readonly TrustedIssuer[];
}

export interface EnvironmentConfig {
  readonly name: string;
  readonly domainAccounts: readonly DomainAccountConfig[];
  readonly frontdoor: FrontdoorConfig;
}

export interface StageConfig {
  readonly name: string;
  readonly shared: SharedConfig;
  readonly environments: readonly EnvironmentConfig[];
}
