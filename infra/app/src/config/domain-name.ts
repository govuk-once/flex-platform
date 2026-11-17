import type { DomainConfig, EnvironmentConfig } from "./types.ts";

/** A domain's name, whether config lists it by name or as disabled. */
export function domainName(domain: DomainConfig): string {
  return typeof domain === "string" ? domain : domain.name;
}

/**
 * Every domain an environment hosts, by name, disabled ones included: a disabled domain keeps
 * its stack and its name.
 */
export function domainNames(environment: EnvironmentConfig): string[] {
  return environment.domainAccounts.flatMap(({ domains }) =>
    domains.map(domainName),
  );
}
