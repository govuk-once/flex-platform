import { DomainAccount } from "@repo/domains-infra";
import { Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

import { domainsFor } from "../config/hosting.ts";
import type {
  DomainAccountConfig,
  EnvironmentConfig,
} from "../config/types.ts";
import { DOMAIN_REGION } from "./domain.ts";

export interface DomainAccountStackOptions {
  readonly environment: EnvironmentConfig;
  readonly domainAccount: DomainAccountConfig;
}

// {section}-{environment}-{thing}, the thing being the account. A domain named <account>-account
// would take the same name, which CDK refuses at synth.
export function domainAccountStackName(
  environment: EnvironmentConfig,
  domainAccount: DomainAccountConfig,
): string {
  return `domain-${environment.name}-${domainAccount.name}-account`;
}

/**
 * What a domain account's domains share in an environment: the certificate, each domain's host,
 * and API Gateway's logging role. Built only where the environment hosts one of the account's
 * domains, and every one of those domains' stacks deploys after it.
 */
export class DomainAccountStack extends Stack {
  constructor(
    scope: Construct,
    { environment, domainAccount }: DomainAccountStackOptions,
  ) {
    super(scope, domainAccountStackName(environment, domainAccount), {
      description: `Flex domain account ${domainAccount.name} for the ${environment.name} environment`,
      env: { account: domainAccount.account, region: DOMAIN_REGION },
      // Deleting it takes every domain's host, and their certificate, with it.
      terminationProtection: true,
    });

    new DomainAccount(this, "DomainAccount", {
      environment: environment.name,
      zone: {
        zoneName: domainAccount.zone.name,
        hostedZoneId: domainAccount.zone.id,
      },
      domainNames: domainsFor(domainAccount, { environment }).map(
        ({ config }) => config.name,
      ),
    });
  }
}
