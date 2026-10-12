import { domainHostName } from "@repo/domains-infra";

import type {
  DomainAccountConfig,
  EnvironmentConfig,
  HostedDomainConfig,
} from "./types.ts";

export interface InEnvironmentOptions {
  readonly environment: EnvironmentConfig;
}

/** The domains a domain account hosts in an environment, in the order the environment lists them. */
export function domainsFor(
  domainAccount: DomainAccountConfig,
  { environment }: InEnvironmentOptions,
): HostedDomainConfig[] {
  return environment.domains.filter(
    (domain) => domain.domainAccount === domainAccount.name,
  );
}

/** The domain account that hosts a domain in an environment. */
export function domainAccountFor(
  domain: HostedDomainConfig,
  { environment }: InEnvironmentOptions,
): DomainAccountConfig {
  const domainAccount = environment.domainAccounts.find(
    ({ name }) => name === domain.domainAccount,
  );

  if (domainAccount === undefined) {
    throw new Error(
      `${environment.name}: the ${domain.config.name} domain's domain account, ${domain.domainAccount}, isn't in the environment`,
    );
  }

  return domainAccount;
}

/** The host a domain's API answers at in an environment. */
export function hostNameFor(
  domain: HostedDomainConfig,
  options: InEnvironmentOptions,
): string {
  const { zone } = domainAccountFor(domain, options);

  return domainHostName(domain.config.name, { zoneName: zone.name });
}

/** The Frontdoor's routing map: each domain the environment hosts, and the host it answers at. */
export function domainRoutesFor(
  environment: EnvironmentConfig,
): Record<string, string> {
  return Object.fromEntries(
    environment.domains.map((domain) => [
      domain.config.name,
      hostNameFor(domain, { environment }),
    ]),
  );
}
