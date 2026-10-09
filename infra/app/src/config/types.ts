import type { TrustedIssuer } from "@repo/frontdoor-cloudfront-function";

// Everything that differs between stages and environments is a value here. Constructs receive
// these values, never a stage or environment name to branch on.

// Names are used in resource names and DNS labels, so each is a lowercase DNS label.

export interface DomainAccountConfig {
  readonly name: string;
  readonly account: string;
}

export interface FrontdoorConfig {
  /** The user pools and app clients whose tokens the edge lets through. */
  readonly issuers: readonly TrustedIssuer[];
  /** Requests one address may make in five minutes before the edge turns it away. */
  readonly rateLimitPerFiveMinutes: number;
  /** How long WAF logs are kept; one of the values CloudWatch Logs offers. */
  readonly logRetentionDays: number;
}

export interface EnvironmentConfig {
  readonly name: string;
  readonly frontdoorAccount: string;
  readonly domainAccounts: readonly DomainAccountConfig[];
  /** The environment's zone, such as `dev.platform.example`; the edge answers at `app.` under it. */
  readonly domainName: string;
  readonly frontdoor: FrontdoorConfig;
}

export interface StageConfig {
  readonly name: string;
  readonly sharedAccount: string;
  readonly environments: readonly EnvironmentConfig[];
}
