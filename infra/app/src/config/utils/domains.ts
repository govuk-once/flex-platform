import { heldValue } from "@repo/utils/held-value";
import { sortedNames } from "@repo/utils/sorted-names";

import type { DomainConfig, EnvironmentConfig, StageConfig } from "../types.ts";

/**
 * Every domain an environment hosts, by name, disabled ones included: a disabled domain keeps
 * its stack and its name.
 */
export function domainNames(environment: EnvironmentConfig): string[] {
  return environment.domainAccounts.flatMap(({ domains }) =>
    domains.map(({ name }) => name),
  );
}

/**
 * Every domain the stage's environments host, once each and by name, disabled ones included: a
 * disabled domain's code can still be released. Config gives one domain one repository wherever it
 * is hosted, which validation holds it to.
 */
export function stageDomains(stage: StageConfig): DomainConfig[] {
  const byName = new Map<string, DomainConfig>();
  for (const environment of stage.environments) {
    for (const { domains } of environment.domainAccounts) {
      for (const { name, repository } of domains) {
        if (!byName.has(name)) byName.set(name, { name, repository });
      }
    }
  }
  return sortedNames(byName.keys()).map((name) => heldValue(byName, name));
}
