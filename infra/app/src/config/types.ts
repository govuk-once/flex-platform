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
