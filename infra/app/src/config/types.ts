import type { TrustedIssuer } from "@repo/frontdoor-shared";
import type { Placement } from "@repo/infra-constructs";

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
  /**
   * The subnets it runs in: `private` reaches its upstream through NAT, `isolated` reaches only
   * the network's endpoints, for an upstream reached privately.
   */
  readonly placement: Placement;
  /**
   * The secret it reads its credentials from, `FLEX_UPSTREAM_SECRET_ARN`: `"create"` for one its
   * stack creates, empty, for a person to fill, or an upstream's own, by its full ARN and the
   * ARN of the key it is encrypted with. Either is in the gateway's region.
   */
  readonly secret: "create" | UpstreamSecretConfig;
  /**
   * `FLEX_UPSTREAM_TARGET`, or `null` where the driver takes the target from the secret.
   */
  readonly target: string | null;
  /** The roles it assumes to sign as, by ARN, such as an upstream's for `sigV4`. */
  readonly roleArns: readonly string[];
}

export interface UpstreamSecretConfig {
  /** The full ARN, with the six characters Secrets Manager adds to the name. */
  readonly arn: string;
  readonly keyArn: string;
}

/**
 * A domain the account hosts: its name, or the domain disabled. A disabled domain keeps its stack,
 * and with it its API, its host, its logs and its name, but the Frontdoor routes nothing to it: a
 * request for it gets the 404 an unknown domain gets. Enabling it again recreates nothing.
 */
export type DomainConfig = string | DisabledDomainConfig;

export interface DisabledDomainConfig {
  readonly name: string;
  readonly disabled: true;
}

export interface DomainAccountConfig {
  readonly name: string;
  readonly account: string;
  /** The domains the account hosts in this environment, disabled ones included. */
  readonly domains: readonly DomainConfig[];
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
