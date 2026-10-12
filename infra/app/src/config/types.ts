import type { DomainConfig, DomainNetwork } from "@repo/domains-infra";
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

export interface DomainAccountConfig {
  readonly name: string;
  readonly account: string;
  /** Each domain answers at `<domain>.<zone>`, under one wildcard certificate. */
  readonly zone: ZoneConfig;
  /**
   * The subnets and security group for each access level that runs in the account's VPC, by ID.
   * The VPC isn't ours, so config names them. `{}` where no domain in the account needs one.
   */
  readonly network: DomainNetwork;
}

/**
 * A domain, declared once, in `config/domains/`. An environment hosts it by listing it, so
 * promoting a domain is adding it to the next environment's list.
 */
export interface HostedDomainConfig {
  /** The name of the domain account that hosts it, the same in every environment that lists it. */
  readonly domainAccount: string;
  readonly config: DomainConfig;
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
  /** The domains the environment hosts. A domain deploys only to environments that list it. */
  readonly domains: readonly HostedDomainConfig[];
  readonly frontdoor: FrontdoorConfig;
  readonly domainAccounts: readonly DomainAccountConfig[];
}

export interface StageConfig {
  readonly name: string;
  readonly shared: SharedConfig;
  readonly environments: readonly EnvironmentConfig[];
}
