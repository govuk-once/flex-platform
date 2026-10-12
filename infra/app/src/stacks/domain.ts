import { Domain } from "@repo/domains-infra";
import { edgeRoleName } from "@repo/frontdoor-infra";
import { SIGNING_REGION } from "@repo/frontdoor-origin-request";
import { Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

import { domainAccountFor, hostNameFor } from "../config/hosting.ts";
import type { EnvironmentConfig, HostedDomainConfig } from "../config/types.ts";

// The edge signs every request for this region, so a domain anywhere else would refuse them all.
export const DOMAIN_REGION = SIGNING_REGION;

export interface DomainStackOptions {
  readonly environment: EnvironmentConfig;
  readonly domain: HostedDomainConfig;
}

// A stage builds every environment in one app, so the name carries the environment and domain.
export function domainStackName(
  environment: EnvironmentConfig,
  domain: HostedDomainConfig,
): string {
  return `domain-${environment.name}-${domain.config.name}`;
}

/** The role the environment's edge signs requests with, built as the frontdoor names it. */
export function edgeRoleArn(environment: EnvironmentConfig): string {
  return `arn:aws:iam::${environment.frontdoor.account}:role/${edgeRoleName(environment.name)}`;
}

/** One domain in one environment, in the domain account that hosts it. */
export class DomainStack extends Stack {
  constructor(scope: Construct, { environment, domain }: DomainStackOptions) {
    const domainAccount = domainAccountFor(domain, { environment });

    super(scope, domainStackName(environment, domain), {
      description: `Flex domain ${domain.config.name} for the ${environment.name} environment`,
      env: { account: domainAccount.account, region: DOMAIN_REGION },
    });

    new Domain(this, domain.config.name, {
      config: domain.config,
      environment: environment.name,
      hostName: hostNameFor(domain, { environment }),
      frontdoorRoleArn: edgeRoleArn(environment),
      network: domainAccount.network,
    });
  }
}
