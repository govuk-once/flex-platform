// Everything that differs between stages and environments is a value here. Constructs receive
// these values, never a stage or environment name to branch on.

// Names are used in resource names and DNS labels, so each is a lowercase DNS label.

export interface DomainAccountConfig {
  readonly name: string;
  readonly account: string;
}

export interface EnvironmentConfig {
  readonly name: string;
  readonly frontdoorAccount: string;
  readonly domainAccounts: readonly DomainAccountConfig[];
}

export interface StageConfig {
  readonly name: string;
  readonly sharedAccount: string;
  readonly environments: readonly EnvironmentConfig[];
}
